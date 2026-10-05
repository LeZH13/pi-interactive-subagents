import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, linkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  claimSession, openSession as openOwner, enqueueMessage, drainInbox, pendingMessages, recordCompletion,
  finalizeSession, abandonStartingSession, withSessionLock, protocolDir, canonicalSessionPath, authorizeLaunch,
} from "../pi-extension/subagents/protocol.ts";
import childExtension from "../pi-extension/subagents/subagent-done.ts";
import { __test__ as runtime } from "../pi-extension/subagents/index.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import { shellEscape } from "../pi-extension/subagents/surface.ts";

function openSession(file: string, owner: Parameters<typeof openOwner>[1]) {
  authorizeLaunch(file, owner);
  openOwner(file, owner);
}

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-protocol-")));
  const file = join(dir, "session.jsonl");
  const owner = claimSession(file, "run-one", true);
  writeFileSync(file, JSON.stringify({ type: "session", id: "test", version: 3 }) + "\n");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const branch: any[] = [];
  const sent: any[] = [];
  const deliver = (item: any) => { sent.push(item); return "queued" as const; };
  const persisted = (item: any) => ({ type: "custom_message", customType: "subagent_steer", details: { messageId: item.messageId, runId: item.runId } });
  return { dir, file, owner, branch, sent, deliver, persisted };
}
function child(t: TestContext) {
  const h = fixture(t);
  const vars = { PI_SUBAGENT_SESSION: h.file, PI_SUBAGENT_RUN_ID: h.owner.runId,
    PI_SUBAGENT_OWNER_TOKEN: h.owner.ownerToken, PI_SUBAGENT_AUTO_EXIT: "1" };
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  const setInterval = globalThis.setInterval;
  const clearInterval = globalThis.clearInterval;
  let poll!: () => void;
  globalThis.setInterval = ((callback: () => void) => { poll = callback; return { unref() {}, ref() {} }; }) as any;
  globalThis.clearInterval = (() => {}) as any;
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  let shutdowns = 0;
  let sendFails = false;
  const notifications: string[] = [];
  const api = {
    on: (event: string, handler: any) => handlers.set(event, handler),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerShortcut() {}, getAllTools: () => [],
    sendMessage: (message: any, options: any) => { if (sendFails) throw new Error("send failed"); h.sent.push({ message, options }); },
  } as any;
  const ctx = { isIdle: () => true, sessionManager: { getBranch: () => h.branch }, shutdown: () => { shutdowns++; },
    ui: { setWidget() {}, notify: (text: string) => notifications.push(text) } } as any;
  authorizeLaunch(h.file, h.owner);
  childExtension(api);
  const emit = (event: string, payload: any = {}) => handlers.get(event)?.(payload, ctx);
  emit("session_start"); emit("before_agent_start"); emit("agent_start");
  const beforeSettle = () => {
    emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    return emit("agent_before_settle", { context: { canContinue: true,
      pendingMessages: h.sent.filter((item) => !h.branch.some((entry) => entry.details?.messageId === item.message.details?.messageId)).map((item) => item.message) } });
  };
  const persist = (index = 0) => {
    const message = h.sent[index].message;
    h.branch.push({ type: "custom_message", customType: message.customType, details: message.details, content: message.content });
  };
  t.after(() => {
    emit("session_shutdown");
    globalThis.setInterval = setInterval; globalThis.clearInterval = clearInterval;
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  return { ...h, emit, beforeSettle, poll: () => poll(), persist, tools, ctx, notifications,
    shutdowns: () => shutdowns, failSend: (value: boolean) => { sendFails = value; } };
}

const moduleUrl = pathToFileURL(resolve("pi-extension/subagents/protocol.ts")).href;

describe("shared session ownership and delivery protocol", { concurrency: false }, () => {
  it("serializes closure-before-enqueue and rejects late input without false acceptance", (t) => {
    const h = fixture(t); openSession(h.file, h.owner);
    const closed = drainInbox(h.file, h.owner, { branch: [], deliver: h.deliver, close: true });
    assert.equal(closed.closed, true);
    assert.throws(() => enqueueMessage(h.file, h.owner, "late"), /closed.*explicit resume/);
    assert.equal(pendingMessages(h.file).length, 0);
    assert.throws(() => claimSession(h.file, "next"), /no matching wrapper completion/);
  });

  it("serializes enqueue-before-closure and cannot close until the persisted ACK", (t) => {
    const h = fixture(t); openSession(h.file, h.owner);
    const item = enqueueMessage(h.file, h.owner, "  中文 🧭\nsecond line\n ");
    const first = drainInbox(h.file, h.owner, { branch: [], deliver: h.deliver, close: true });
    assert.equal(first.closed, false); assert.equal(first.dispatched, 1);
    const again = drainInbox(h.file, h.owner, { branch: [], deliver: h.deliver, close: true });
    assert.equal(again.dispatched, 0); assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].body, item.body);
    const done = drainInbox(h.file, h.owner, { branch: [h.persisted(item)], deliver: h.deliver, close: true });
    assert.equal(done.closed, true); assert.equal(done.pending.length, 0);
    assert.equal(readdirSync(join(protocolDir(h.file), "inbox")).length, 1, "immutable records remain available");
  });

  it("uses branch persistence, not message_end or void sendMessage, as the ACK", (t) => {
    const h = child(t);
    const item = enqueueMessage(h.file, h.owner, "unmodified\nreply 🌍");
    h.poll(); assert.equal(h.sent.length, 1);
    assert.deepEqual(h.sent[0].message.details, { messageId: item.messageId, runId: item.runId, deliveryRunId: h.owner.runId });
    h.emit("message_end", { message: { role: "custom", ...h.sent[0].message } });
    h.poll(); h.poll();
    assert.equal(pendingMessages(h.file).length, 1);
    assert.equal(h.sent.length, 1, "delayed ACK must not cause duplicate dispatch");
    assert.deepEqual(h.beforeSettle(), { continue: true });
    assert.equal(h.shutdowns(), 0);
    h.persist(); h.poll();
    assert.equal(pendingMessages(h.file).length, 0);
    h.beforeSettle(); h.emit("agent_settled");
    assert.equal(h.shutdowns(), 1);
    assert.throws(() => enqueueMessage(h.file, h.owner, "late"), /delivery is closed/);
  });

  it("retains inbox items on sendMessage failure and retries only undispatched IDs", (t) => {
    const h = child(t);
    const item = enqueueMessage(h.file, h.owner, "retry without loss");
    h.failSend(true); h.poll();
    assert.equal(h.sent.length, 0); assert.equal(pendingMessages(h.file)[0].messageId, item.messageId);
    h.beforeSettle(); h.emit("agent_settled");
    assert.equal(h.shutdowns(), 0); assert.ok(h.notifications.some((text) => text.includes("send failed")));
    h.failSend(false); h.poll(); h.poll();
    assert.equal(h.sent.length, 1);
    h.persist(); h.beforeSettle(); h.emit("agent_settled");
    assert.equal(h.shutdowns(), 1);
  });

  it("retries a busy settlement mutex while idle and preserves the fresh error without another turn", (t) => {
    const h = child(t);
    withSessionLock(h.file, () => {
      h.emit("message_end", { message: { role: "assistant", stopReason: "error", errorMessage: "fresh failure 🦊" } });
      h.emit("agent_before_settle", { context: { canContinue: false, pendingMessages: [] } });
      h.emit("agent_settled");
      assert.equal(h.shutdowns(), 0);
    });
    h.poll();
    assert.equal(h.shutdowns(), 1, "released mutex completes the already-authorized idle exit");
    assert.equal(h.sent.length, 0);
    assert.equal(JSON.parse(readFileSync(`${h.file}.exit`, "utf8")).errorMessage, "fresh failure 🦊");
  });

  it("finishes idle closure when a dispatched message's persisted ACK arrives after settlement", (t) => {
    const h = child(t);
    enqueueMessage(h.file, h.owner, "delayed durable ACK"); h.poll();
    h.emit("message_end", { message: { role: "assistant", stopReason: "stop" } });
    h.emit("agent_before_settle", { context: { canContinue: false, pendingMessages: [] } });
    h.emit("agent_settled");
    assert.equal(h.shutdowns(), 0);
    h.persist(); h.poll();
    assert.equal(h.shutdowns(), 1);
    assert.equal(h.sent.length, 1, "no new prompt or duplicate dispatch is needed to reconcile the receipt");
  });

  it("ACKs an ask_question reply after resolving its waiter, without a duplicate custom message", async (t) => {
    const h = child(t);
    const answer = h.tools.get("ask_question").execute("ask", { question: "Which region?" }, undefined, undefined, h.ctx);
    const item = enqueueMessage(h.file, h.owner, "eu-west\nwith Unicode 🦊");
    h.poll();
    assert.equal((await answer).details.answer, item.body);
    assert.equal(h.sent.length, 0); assert.equal(pendingMessages(h.file).length, 0);
    const ack = JSON.parse(readFileSync(join(protocolDir(h.file), "acks", `${item.messageId}.json`), "utf8"));
    assert.equal(ack.kind, "question");
    h.poll(); assert.equal(h.sent.length, 0);
  });

  it("recovers unread and previously dispatched unacknowledged items only on an explicit new owner", (t) => {
    const h = fixture(t); openSession(h.file, h.owner);
    const unread = enqueueMessage(h.file, h.owner, "unread");
    const dispatched = enqueueMessage(h.file, h.owner, "dispatched but not persisted");
    drainInbox(h.file, h.owner, { branch: [], deliver: h.deliver, close: false });
    const foreign = { ...unread, messageId: "00000000-0000-0000-0000-000000000001", runId: "mismatched-run", body: "retained mismatched record" };
    writeFileSync(join(protocolDir(h.file), "inbox", "foreign.json"), JSON.stringify(foreign));
    drainInbox(h.file, h.owner, { branch: [], deliver: h.deliver, close: true });
    assert.equal(h.sent.length, 2, "foreign records cannot be silently consumed by a live run");
    recordCompletion(h.file, h.owner, 1);
    assert.throws(() => enqueueMessage(h.file, h.owner, "arrived after process exit"), /writer has exited/);
    const next = claimSession(h.file, "explicit-resume"); openSession(h.file, next);
    const recovered: any[] = [];
    const result = drainInbox(h.file, next, { branch: [h.persisted(dispatched)],
      deliver: (item) => { recovered.push(item); return "queued"; }, close: true });
    assert.deepEqual(recovered.map((item) => item.messageId).sort(), [unread.messageId, foreign.messageId].sort());
    assert.equal(result.closed, false); assert.equal(result.pending.length, 2);
    assert.equal(recovered[0].body, unread.body);
    assert.equal(recovered[0].runId, h.owner.runId, "immutable original run identity is preserved");
  });

  it("authorizes a launch script once and never starts a duplicate/stale writer", (t) => {
    const h = fixture(t);
    authorizeLaunch(h.file, h.owner);
    assert.throws(() => authorizeLaunch(h.file, h.owner), /duplicate\/stale launch/);
    assert.throws(() => abandonStartingSession(h.file, h.owner), /after child startup/);
    recordCompletion(h.file, h.owner, 0);
    const next = claimSession(h.file, "new-writer");
    assert.throws(() => authorizeLaunch(h.file, h.owner), /token\/run/);
    assert.doesNotThrow(() => authorizeLaunch(h.file, next));
  });

  it("does not erase pending inbox, ACKs, or completion evidence when clearing launch signals", (t) => {
    const h = fixture(t); openSession(h.file, h.owner);
    const item = enqueueMessage(h.file, h.owner, "retained"); recordCompletion(h.file, h.owner, 0);
    runtime.clearRunSignals(h.file);
    assert.equal(pendingMessages(h.file)[0].messageId, item.messageId);
    assert.equal(existsSync(`${h.file}.complete`), true);
  });

  it("refuses unknown owners, active/closed writers, stale completions and foreign child startup", (t) => {
    const h = fixture(t);
    assert.throws(() => claimSession(join(h.dir, "unknown.jsonl"), "run"), /Unknown session owner/);
    assert.throws(() => claimSession(h.file, "other"), /starting writer/);
    writeFileSync(`${h.file}.complete`, JSON.stringify({ type: "completion", runId: h.owner.runId, ownerToken: "foreign", completedAt: Date.now(), exitCode: 0 }));
    assert.throws(() => claimSession(h.file, "other"), /no matching wrapper completion/);
    assert.throws(() => openSession(h.file, { ...h.owner, runId: "stale-run" }), /token\/run/);
    openSession(h.file, h.owner);
    assert.throws(() => abandonStartingSession(h.file, h.owner), /after child startup/);
    assert.throws(() => claimSession(h.file, "other"), /open writer/);
  });

  it("allows only matching wrapper completion to transition, and stale watchers cannot erase a successor", (t) => {
    const h = fixture(t); openSession(h.file, h.owner);
    recordCompletion(h.file, h.owner, 0);
    const next = claimSession(h.file, "next");
    assert.equal(existsSync(`${h.file}.complete`), false, "transition consumes previous completion evidence");
    recordCompletion(h.file, next, 2);
    const before = readFileSync(`${h.file}.complete`, "utf8");
    assert.equal(finalizeSession(h.file, h.owner), true, "archived proof confirms old termination without changing newer ownership");
    assert.equal(readFileSync(`${h.file}.complete`, "utf8"), before);
    assert.throws(() => recordCompletion(h.file, h.owner, 3), /token\/run/);
    assert.equal(readFileSync(`${h.file}.complete`, "utf8"), before);
  });

  it("rolls a pre-command failed resume back to the completed owner without stealing another owner", (t) => {
    const h = fixture(t); recordCompletion(h.file, h.owner, 0);
    const attempted = claimSession(h.file, "attempt");
    abandonStartingSession(h.file, attempted);
    assert.equal(JSON.parse(readFileSync(`${h.file}.complete`, "utf8")).ownerToken, h.owner.ownerToken);
    const next = claimSession(h.file, "next");
    assert.throws(() => abandonStartingSession(h.file, attempted), /token\/run/);
    assert.equal(JSON.parse(readFileSync(join(protocolDir(h.file), "owner.json"), "utf8")).ownerToken, next.ownerToken);
  });

  it("shares canonical symlink/ancestor ownership and rejects multiply hard-linked sessions", (t) => {
    const h = fixture(t);
    const dirAlias = join(h.dir, "alias-dir"); symlinkSync(h.dir, dirAlias);
    assert.equal(canonicalSessionPath(join(dirAlias, "not-created.jsonl")), join(h.dir, "not-created.jsonl"));
    const alias = join(h.dir, "alias.jsonl"); symlinkSync(h.file, alias);
    assert.throws(() => claimSession(alias, "alias-run"), /starting writer/);
    linkSync(h.file, join(h.dir, "hard-link.jsonl"));
    assert.throws(() => claimSession(h.file, "hard-link-run"), /multiply hard-linked/);
  });

  it("rejects foreign claims from another Node process using the exact shared filesystem API", (t) => {
    const h = fixture(t);
    const source = `import {claimSession} from ${JSON.stringify(moduleUrl)}; claimSession(process.argv[1],"foreign-process");`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, h.file], { encoding: "utf8" });
    assert.equal(result.status, 1); assert.match(result.stderr, /starting writer.*no matching wrapper completion/);
    // Diagnostic PID never licenses an age/PID-based owner steal.
    const path = join(protocolDir(h.file), "owner.json");
    writeFileSync(path, JSON.stringify({ ...h.owner, phase: "open", pid: 99999999 }));
    const again = spawnSync(process.execPath, ["--input-type=module", "-e", source, h.file], { encoding: "utf8" });
    assert.equal(again.status, 1); assert.match(again.stderr, /open writer/);
  });

  it("fails closed on a cross-process held mutex and never reclaims an abandoned lock", async (t) => {
    const h = fixture(t);
    const source = `import {withSessionLock} from ${JSON.stringify(moduleUrl)}; import fs from "node:fs"; withSessionLock(process.argv[1],()=>{console.log("locked");fs.readFileSync(0,"utf8")});`;
    const processChild = spawn(process.execPath, ["--input-type=module", "-e", source, h.file], { stdio: ["pipe", "pipe", "pipe"] });
    t.after(() => processChild.kill());
    await new Promise<void>((yes, no) => { processChild.stdout.once("data", () => yes()); processChild.once("error", no); });
    assert.throws(() => enqueueMessage(h.file, h.owner, "racing"), /mutex busy or abandoned/);
    const exited = new Promise<void>((yes) => processChild.once("exit", () => yes()));
    processChild.stdin.end(); await exited;
    assert.equal(pendingMessages(h.file).length, 0);
    mkdirSync(join(protocolDir(h.file), "lock"));
    assert.throws(() => claimSession(h.file, "stale-lock"), /No automatic lock recovery/);
  });

  it("preserves long Unicode/multiline final text inside the wrapper, including error presentations", async (t) => {
    const h = fixture(t);
    const retained = enqueueMessage(h.file, h.owner, "accepted but not consumed before unexpected exit");
    const summary = "  起点 🧭\n" + "中文 café 🦊\nline two\n".repeat(20000) + "\n终点  ";
    const input = join(h.dir, "summary.txt"); writeFileSync(input, summary);
    const source = 'const fs=require("node:fs");fs.appendFileSync(process.argv[1],JSON.stringify({type:"message",id:"answer",message:{role:"assistant",content:[{type:"text",text:fs.readFileSync(process.argv[2],"utf8")}],stopReason:"stop"}})+"\\n")';
    const command = `exec ${shellEscape(process.execPath)} -e ${shellEscape(source)} ${shellEscape(h.file)} ${shellEscape(input)}`;
    execFileSync("bash", ["-c", runtime.wrapCommandWithCompletion(command, `${h.file}.complete`, h.owner.runId, h.owner.ownerToken)]);
    const run = { id: "result", runId: h.owner.runId, ownerToken: h.owner.ownerToken, name: "Unicode", task: "summary", surface: "bg:result",
      sessionFile: h.file, startTime: Date.now() - 1000, interactive: false, statusState: createStatusState({ source: "pi", startTimeMs: 0 }) };
    const result = await runtime.lifecycle.watchSubagent(run, new AbortController().signal);
    assert.equal(result.summary, summary);
    assert.equal(result.undeliveredMessages?.[0].messageId, retained.messageId);
    assert.equal(pendingMessages(h.file)[0].body, retained.body);
    assert.ok(runtime.resolveResultPresentation(result, run.name).includes(retained.messageId));
    assert.ok(runtime.resolveResultPresentation(result, run.name).includes(summary));
    assert.ok(runtime.resolveResultPresentation({ ...result, errorMessage: "provider failed" }, run.name).includes(summary));
    assert.equal(existsSync(`${h.file}.complete`), true, "watching preserves ownership evidence");
  });

  it("drains and ACKs through the real SDK pre-settlement lifecycle offline", async (t) => {
    const h = fixture(t);
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
    const { createAssistantMessageEventStream, createProvider } = await import("@earendil-works/pi-ai");
    const vars = { PI_SUBAGENT_SESSION: h.file, PI_SUBAGENT_RUN_ID: h.owner.runId,
      PI_SUBAGENT_OWNER_TOKEN: h.owner.ownerToken, PI_SUBAGENT_AUTO_EXIT: "1" };
    const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
    Object.assign(process.env, vars);
    t.after(() => { for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    } });
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    authorizeLaunch(h.file, h.owner);
    let extraContinuation = false;
    let calls = 0;
    const resources = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [childExtension, (pi) => {
        pi.on("agent_before_settle", () => {
          if (calls === 2 && !extraContinuation) {
            extraContinuation = true;
            return { entries: [{ type: "custom_message", customType: "test_boundary_continue", content: "late boundary follow-up", display: false }], continue: true };
          }
        });
      }] });
    await resources.reload();
    const modelRuntime = await ModelRuntime.create({ authPath: join(h.dir, "auth.json"), modelsPath: join(h.dir, "models.json") });
    const model = { id: "offline", provider: "offline-test", api: "openai-completions", name: "Offline",
      baseUrl: "http://invalid.local", input: ["text"], reasoning: false, contextWindow: 64000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
    const body = "actual SDK ingestion\n中文 🦊";
    let accepted: ReturnType<typeof enqueueMessage> | undefined;
    const streamOffline = (_model: import("@earendil-works/pi-ai").Model<any>, context: import("@earendil-works/pi-ai").TranscriptContext) => {
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [{ type: "text", text: "done" }], stopReason: "stop",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any;
      calls++;
      if (calls === 1) accepted = enqueueMessage(h.file, h.owner, body);
      else {
        assert.ok(context.messages.some((entry: any) => entry.role === "custom" && entry.content === body));
        assert.equal(JSON.parse(readFileSync(join(protocolDir(h.file), "owner.json"), "utf8")).phase, "open", "a later SDK continuation reopens delivery for the same writer");
      }
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: "stop", message }); stream.end(message);
      return stream;
    };
    modelRuntime.registerNativeProvider(createProvider({ id: model.provider, models: [model],
      auth: { apiKey: { name: "Offline test", resolve: async () => ({ auth: { apiKey: "offline-test" } }) } },
      api: { stream: streamOffline, streamSimple: streamOffline } }));
    const { session } = await createAgentSession({ cwd: h.dir, agentDir: h.dir, model, modelRuntime,
      resourceLoader: resources, sessionManager: SessionManager.open(h.file), settingsManager, tools: [] });
    t.after(async () => { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); });
    let shutdowns = 0;
    const errors: string[] = [];
    await session.bindExtensions({ mode: "print", shutdownHandler: () => { shutdowns++; }, onError: (error) => errors.push(error.error) });
    await session.prompt("initial task");
    assert.deepEqual(errors, []);
    assert.equal(calls, 3, "accepted input and another boundary handler each request one SDK continuation");
    assert.equal(shutdowns, 1);
    assert.equal(pendingMessages(h.file).length, 0);
    assert.ok(session.sessionManager.getBranch().some((entry: any) => entry.type === "custom_message" && entry.details?.messageId === accepted!.messageId));
    assert.throws(() => enqueueMessage(h.file, h.owner, "late SDK message"), /closed/);
  });

  it("preserves PTY stdin/stdout and actual interactive input while tracking the child", (t) => {
    const h = fixture(t);
    const node = `console.log(JSON.stringify({kind:'ready',stdin:process.stdin.isTTY,stdout:process.stdout.isTTY}));process.stdin.once('data',data=>{console.log('got:'+data.toString().trim());process.exit(0)});process.stdin.resume()`;
    const script = join(h.dir, "pty-launch.sh");
    writeFileSync(script, runtime.wrapCommandWithCompletion(`exec node -e ${shellEscape(node)}`, `${h.file}.complete`, h.owner.runId, h.owner.ownerToken));
    const output = execFileSync("python3", ["-c", `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
process = subprocess.Popen(['bash', sys.argv[1]], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)
output = b''
sent = False
deadline = time.monotonic() + 5
try:
  while time.monotonic() < deadline:
    ready, _, _ = select.select([master], [], [], max(0, deadline - time.monotonic()))
    if not ready: break
    try: chunk = os.read(master, 65536)
    except OSError: break
    if not chunk: break
    output += chunk
    if b'"kind":"ready"' in output and not sent:
      os.write(master, b'PTY_INTERACTIVE_INPUT\\n')
      sent = True
    if b'got:PTY_INTERACTIVE_INPUT' in output: break
  process.wait(timeout=5)
  assert process.returncode == 0, output
  print(output.decode('utf-8'), end='')
finally:
  if process.poll() is None:
    process.terminate()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.kill(); process.wait()
  os.close(master)
`, script], { encoding: "utf8", timeout: 15_000 });
    assert.match(output, /"stdin":true,"stdout":true/);
    assert.match(output, /got:PTY_INTERACTIVE_INPUT/);
    assert.equal(JSON.parse(readFileSync(`${h.file}.complete`, "utf8")).exitCode, 0);
    assert.equal(finalizeSession(h.file, h.owner), true);
  });

  it("writes wrapper completion only after its actual Pi child exits on cancellation", async (t) => {
    const h = fixture(t);
    const source = 'console.log("ready:"+process.pid);setInterval(()=>{},1000)';
    const command = `exec ${shellEscape(process.execPath)} -e ${shellEscape(source)}`;
    const wrapped = spawn("bash", ["-c", runtime.wrapCommandWithCompletion(command, `${h.file}.complete`, h.owner.runId, h.owner.ownerToken)], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => wrapped.kill("SIGKILL"));
    const pid = await new Promise<number>((yes, no) => { wrapped.stdout.once("data", (data) => yes(Number(String(data).match(/ready:(\d+)/)![1]))); wrapped.once("error", no); });
    assert.equal(existsSync(`${h.file}.complete`), false);
    const exited = new Promise<void>((yes) => wrapped.once("exit", () => yes()));
    wrapped.kill("SIGTERM"); await exited;
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
    assert.equal(JSON.parse(readFileSync(`${h.file}.complete`, "utf8")).ownerToken, h.owner.ownerToken);
    assert.doesNotThrow(() => claimSession(h.file, "after-cancel"));
  });
});
