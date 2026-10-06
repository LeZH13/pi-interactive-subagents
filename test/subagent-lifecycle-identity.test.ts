import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension, { __test__ as runtime } from "../pi-extension/subagents/index.ts";
import { claimSession, recordCompletion, protocolDir, pendingMessages } from "../pi-extension/subagents/protocol.ts";
import { DEFAULT_SUBAGENTS_CONFIG } from "../pi-extension/subagents/config.ts";
import { readNameRegistry, registerName, writeSubagentLoadout, readSubagentLoadout } from "../pi-extension/subagents/session.ts";

function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function admissionCount(profile: string) {
  return [...runtime.profileAdmissions.values()].reduce((sum, counts) => sum + (counts.get(profile) ?? 0), 0);
}

function setup(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-lifecycle-")));
  const oldCwd = process.cwd();
  const envKeys = ["PI_CODING_AGENT_DIR", "PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT"];
  const env = envKeys.map((key) => process.env[key]);
  const original = { ...runtime.lifecycle };
  const config = runtime.getSubagentsConfigState().get();
  process.chdir(dir);
  process.env.PI_CODING_AGENT_DIR = join(dir, "config");
  delete process.env.PI_SUBAGENT_ALLOWED;
  delete process.env.PI_SUBAGENT_AGENT;
  mkdirSync(join(dir, "config", "agents"), { recursive: true });
  function profile(name: string, maxConcurrent?: number, cli?: string) {
    writeFileSync(join(dir, "config", "agents", `${name}.md`), `---\nname: ${name}\n${maxConcurrent === undefined ? "" : `max-concurrent: ${maxConcurrent}\n`}${cli ? `cli: ${cli}\n` : ""}tools: read\nauto-exit: true\nsession-mode: lineage-only\n---\nTest agent\n`);
  }
  profile("worker", 1);
  profile("scout");
  profile("reviewer");
  runtime.getSubagentsConfigState().replace(DEFAULT_SUBAGENTS_CONFIG);
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  const messages: any[] = [];
  const api = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    on: (name: string, handler: any) => events.set(name, handler),
    getActiveTools: () => ["read"], getAllTools: () => [], getCommands: () => [],
    sendMessage: (message: any) => messages.push(message),
  } as any;
  const parent = { file: join(dir, "parent.jsonl"), id: "parent" };
  writeFileSync(parent.file, JSON.stringify({ type: "session", version: 3, id: parent.id, cwd: dir }) + "\n");
  const ctx = { cwd: dir, hasUI: false, sessionManager: {
    getSessionFile: () => parent.file, getSessionDir: () => dir,
    getSessionId: () => parent.id, getLeafId: () => null,
  } } as any;
  extension(api);
  events.get("session_start")({}, ctx);
  const surfaces: { name: string; sessionFile: string }[] = [];
  const commands: string[] = [];
  const closed: string[] = [];
  const watches: { run: any; done: ReturnType<typeof gate<any>> }[] = [];
  runtime.lifecycle.createSurface = async (name, options) => {
    surfaces.push({ name, sessionFile: options!.sessionFile! });
    return `bg:${options!.id}`;
  };
  runtime.lifecycle.sendLongCommand = async (_surface, command) => { commands.push(command); return "mock-script"; };
  runtime.lifecycle.closeSurface = async (surface) => { closed.push(surface); };
  runtime.lifecycle.watchSubagent = (run, signal) => {
    const done = gate<any>();
    watches.push({ run, done });
    signal.addEventListener("abort", () => done.resolve({ exitCode: 1, interrupted: true }), { once: true });
    return done.promise.then((result) => {
      recordCompletion(run.sessionFile, { ownerToken: run.ownerToken!, runId: run.runId }, result.exitCode ?? 0);
      runtime.runningSubagents.delete(run.id);
      const retained = pendingMessages(run.sessionFile);
      return { name: run.name, task: run.task, summary: "Done", elapsed: 1, sessionFile: run.sessionFile,
        ...(retained.length ? { undeliveredMessages: retained } : {}),
        hasAssistantText: true, exitCode: 0, ...result };
    });
  };
  const call = (tool: string, params: any) => tools.get(tool).execute("test", params, undefined, undefined, ctx);
  const artifactDir = () => join(dir, "artifacts", parent.id);
  function session(name: string, agent = "scout", registeredName?: string) {
    const file = join(dir, `${name}.jsonl`);
    const prior = claimSession(file, `prior-${name}`, true);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: name, cwd: dir }) + "\n");
    writeSubagentLoadout(file, { agent, toolAllowlist: "read,ask_question", model: null, thinking: null,
      systemPromptMode: null, identity: null, spawnable: [], autoExit: true, cwd: dir, agentDir: null });
    recordCompletion(file, prior, 0);
    if (registeredName) registerName(artifactDir(), registeredName, { sessionFile: file, sessionId: name });
    return file;
  }
  t.after(async () => {
    for (const { done } of watches) done.resolve({ interrupted: true });
    await flush();
    await events.get("session_shutdown")({}, ctx);
    Object.assign(runtime.lifecycle, original);
    runtime.getSubagentsConfigState().replace(config);
    runtime.setTestContext(null);
    runtime.reservedNames.clear(); runtime.sessionReservations.clear(); runtime.profileAdmissions.clear();
    process.chdir(oldCwd);
    for (let i = 0; i < envKeys.length; i++) {
      if (env[i] === undefined) delete process.env[envKeys[i]];
      else process.env[envKeys[i]] = env[i];
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const completeClaims = () => {
    for (const [file, reservation] of runtime.sessionReservations) {
      if (reservation.owner) recordCompletion(file, reservation.owner, 1);
    }
  };
  return { dir, parent, ctx, api, surfaces, commands, watches, messages, closed, call, session, profile, artifactDir, original, completeClaims };
}

function assertError(result: any, pattern: RegExp) {
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.status, "error");
  assert.match(result.details.error, pattern);
}

describe("lifecycle identity and launch reservations", { concurrency: false }, () => {
  it("reserves generated and explicit names before simultaneous launches; finished handles never overwrite", async (t) => {
    const h = setup(t);
    const start = gate<string>();
    runtime.lifecycle.createSurface = async (name, opts) => {
      h.surfaces.push({ name, sessionFile: opts!.sessionFile! });
      return start.promise;
    };
    const first = h.call("subagent", { agent: "scout", task: "one" });
    const second = h.call("subagent", { agent: "scout", task: "two" });
    const explicit = h.call("subagent", { agent: "reviewer", name: "Review", task: "three" });
    assert.deepEqual(h.surfaces.map((s) => s.name), ["scout", "scout-2", "Review"]);
    assertError(await h.call("subagent", { agent: "reviewer", name: "Review", task: "duplicate" }), /already taken/);
    start.resolve("bg:test");
    const results = await Promise.all([first, second, explicit]);
    assert.deepEqual(results.map((r) => r.details.name), ["scout", "scout-2", "Review"]);
    assertError(await h.call("subagent", { agent: "scout", name: "Review", task: "running duplicate" }), /already taken/);
    h.watches[2].done.resolve({});
    await flush();
    const recorded = readNameRegistry(h.artifactDir()).Review;
    assertError(await h.call("subagent", { agent: "reviewer", name: "Review", task: "finished duplicate" }), /already taken/);
    assert.deepEqual(readNameRegistry(h.artifactDir()).Review, recorded);
    const next = await h.call("subagent", { agent: "scout", task: "next" });
    assert.equal(next.details.name, "scout-3");
  });

  for (const exitCode of [0, 1]) {
    it(`forwards completion telemetry for resumed Pi agents (exit ${exitCode})`, async (t) => {
      const h = setup(t);
      const file = h.session("bash-guard-worker", "worker");
      const stats = {
        model: "test/model", thinking: "high", toolCount: 13,
        inputTokens: 3200, outputTokens: 500, cacheReadTokens: 1000,
        cacheWriteTokens: 200, contextTokens: 4900, cost: 0.012,
      };
      const resumed = await h.call("subagent_message", { sessionPath: file, message: "continue" });
      assert.equal(resumed.details.status, "started");
      h.watches[0].done.resolve({ exitCode, elapsed: 446, stats });
      await flush();
      const completed = h.messages.find((message) => message.customType === "subagent_result");
      assert.ok(completed);
      assert.equal(completed.details.agent, "worker");
      assert.equal(completed.details.exitCode, exitCode);
      assert.deepEqual(completed.details.stats, stats);
    });
  }

  it("joins simultaneous name/path/symlink resumes and persists a new path handle for followup", async (t) => {
    const h = setup(t);
    const file = h.session("outside");
    const alias = join(h.dir, "alias.jsonl");
    symlinkSync(file, alias);
    const start = gate<string>();
    runtime.lifecycle.createSurface = async (name, opts) => {
      h.surfaces.push({ name, sessionFile: opts!.sessionFile! });
      return start.promise;
    };
    const first = h.call("subagent_message", { sessionPath: alias, message: "initial" });
    const second = h.call("subagent_message", { sessionPath: join(h.dir, ".", "outside.jsonl"), message: "distinct second" });
    const third = h.call("subagent_message", { name: "outside", message: "distinct third" });
    assert.equal(h.surfaces.length, 1);
    start.resolve("bg:resume");
    const [a, b, c] = await Promise.all([first, second, third]);
    assert.equal(a.details.status, "started");
    assert.equal(b.details.status, "queued");
    assert.equal(c.details.status, "queued");
    assert.equal(b.details.id, a.details.id);
    assert.equal(c.details.id, a.details.id);
    const inbox = join(protocolDir(file), "inbox");
    const queued = readdirSync(inbox).map((entry) => JSON.parse(readFileSync(join(inbox, entry), "utf8")).body);
    assert.deepEqual(queued.sort(), ["distinct second", "distinct third"]);
    assert.equal(readNameRegistry(h.artifactDir()).outside.sessionFile, file);
    h.watches[0].done.resolve({});
    await flush();
    const followup = await h.call("subagent_message", { name: "outside", message: "next run" });
    assert.equal(followup.details.status, "started");
    assert.equal(followup.details.name, "outside");
    assert.equal(h.surfaces.length, 2);
  });

  it("joins known finished names during startup, and rejects a colliding explicit spawn", async (t) => {
    const h = setup(t);
    h.session("finished", "scout", "Known");
    const start = gate<string>();
    runtime.lifecycle.createSurface = async () => start.promise;
    const a = h.call("subagent_message", { name: "Known", message: "one" });
    const b = h.call("subagent_message", { name: "Known", message: "two" });
    assert.equal(runtime.sessionReservations.size, 1);
    assertError(await h.call("subagent", { agent: "scout", name: "Known", task: "clobber" }), /already taken/);
    start.resolve("bg:known");
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first.details.id, second.details.id);
    assert.equal(h.watches.length, 1);
  });

  it("reports failed startup to all joiners and releases session/name/worker ownership", async (t) => {
    const h = setup(t);
    const file = h.session("failed", "worker");
    const start = gate<string>();
    runtime.lifecycle.createSurface = async () => start.promise;
    const a = h.call("subagent_message", { sessionPath: file, message: "one" });
    const b = h.call("subagent_message", { sessionPath: file, message: "two" });
    assert.equal(admissionCount("worker"), 1);
    start.reject(new Error("surface unavailable"));
    const results = await Promise.all([a, b]);
    for (const result of results) assertError(result, /startup failed: surface unavailable/);
    assert.equal(runtime.sessionReservations.size, 0);
    assert.equal(runtime.reservedNames.size, 0);
    assert.equal(admissionCount("worker"), 0);
    runtime.lifecycle.createSurface = async () => "bg:retry";
    assert.equal((await h.call("subagent_message", { sessionPath: file, message: "retry" })).details.status, "started");
  });

  it("releases spawn reservations on surface or command failures and tears down allocated surfaces", async (t) => {
    const h = setup(t);
    runtime.lifecycle.createSurface = async () => { throw new Error("create failed"); };
    assertError(await h.call("subagent", { agent: "worker", name: "Failure", task: "test" }), /create failed/);
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.reservedNames.size, 0);
    assert.equal(runtime.sessionReservations.size, 0);
    runtime.lifecycle.createSurface = async () => "bg:allocated";
    runtime.lifecycle.sendLongCommand = async () => { h.completeClaims(); throw new Error("command failed"); };
    assertError(await h.call("subagent", { agent: "worker", name: "Failure", task: "test" }), /command failed/);
    assert.deepEqual(h.closed, ["bg:allocated"]);
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
    runtime.lifecycle.sendLongCommand = async () => "mock-script";
    assert.equal((await h.call("subagent", { agent: "worker", name: "Failure", task: "retry" })).details.status, "started");
  });

  it("enforces the worker PROFILE slot across spawn/resume while scouts and cosmetic worker names parallel", async (t) => {
    const h = setup(t);
    const otherWorker = h.session("other-worker", "worker", "FinishedWorker");
    const start = gate<string>();
    runtime.lifecycle.createSurface = async () => start.promise;
    const worker = h.call("subagent", { agent: "worker", name: "Implementer", task: "one" });
    assertError(await h.call("subagent", { agent: "worker", name: "Different", task: "two" }), /"worker" profile \(maxConcurrent: 1\)/);
    assertError(await h.call("subagent_message", { sessionPath: otherWorker, message: "resume" }), /"worker" profile \(maxConcurrent: 1\)/);
    const scout = h.call("subagent", { agent: "scout", name: "worker", task: "scout" });
    const reviewer = h.call("subagent", { agent: "reviewer", task: "review" });
    start.resolve("bg:parallel");
    assert.deepEqual((await Promise.all([worker, scout, reviewer])).map((r) => r.details.status), ["started", "started", "started"]);
    h.watches[0].done.resolve({});
    await flush();
    const resume = await h.call("subagent_message", { name: "FinishedWorker", message: "resume" });
    assert.equal(resume.details.status, "started");
    assertError(await h.call("subagent", { agent: "worker", task: "blocked" }), /"worker" profile \(maxConcurrent: 1\)/);
    const third = h.session("third-worker", "worker");
    assertError(await h.call("subagent_message", { sessionPath: third, message: "blocked" }), /"worker" profile \(maxConcurrent: 1\)/);
    const same = await h.call("subagent_message", { sessionPath: otherWorker, message: "same writer" });
    assert.equal(same.details.id, resume.details.id);
    assert.equal(same.details.status, "queued");
    assert.equal(admissionCount("worker"), 1, "active messages do not consume another admission");
  });

  it("holds the captured parent's slot through fallback launch, retry watch, and final result delivery", async (t) => {
    const h = setup(t);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG,
      agents: { worker: { model: "test/primary", modelFallback: "test/retry" } } });
    const started = await h.call("subagent", { agent: "worker", name: "Retry", task: "work" });
    const acceptedPrimary = await h.call("subagent_message", { name: "Retry", message: "unacknowledged primary instruction" });
    const originalParent = { ...h.parent };
    const fallbackStart = gate<string>();
    runtime.lifecycle.createSurface = async (name, opts) => {
      h.surfaces.push({ name, sessionFile: opts!.sessionFile! });
      return fallbackStart.promise;
    };
    h.parent.file = join(h.dir, "other-parent.jsonl"); h.parent.id = "other-parent";
    h.watches[0].done.resolve({ exitCode: 1 });
    await flush();
    assert.equal(h.surfaces.length, 2);
    assert.ok(h.surfaces[1].sessionFile.includes(join("artifacts", originalParent.id)));
    assert.equal(runtime.getProfileAdmissionCount(runtime.canonicalSessionPath(originalParent.file), "worker") > 0, true);
    h.parent.file = originalParent.file; h.parent.id = originalParent.id;
    assertError(await h.call("subagent", { agent: "worker", task: "fallback race" }), /"worker" profile \(maxConcurrent: 1\)/);
    assertError(await h.call("subagent_message", { sessionPath: started.details.sessionFile, message: "finalizing old writer" }), /finalizing/);
    const joinedFallback = h.call("subagent_message", { name: "Retry", message: "retry instruction" });
    fallbackStart.resolve("bg:fallback");
    assert.equal((await joinedFallback).details.status, "queued");
    await flush();
    assert.equal(h.watches.length, 2);
    const liveFallback = await h.call("subagent_message", { name: "Retry", message: "live retry instruction" });
    assert.equal(liveFallback.details.id, h.watches[1].run.id);
    h.api.sendMessage = (message: any) => {
      assert.equal(admissionCount("worker"), 1, "slot survives result transport finalization");
      assert.ok(runtime.sessionReservations.size > 0, "writer reservations survive result transport finalization");
      h.messages.push(message);
    };
    assertError(await h.call("subagent", { agent: "worker", task: "retry race" }), /"worker" profile \(maxConcurrent: 1\)/);
    h.watches[1].done.resolve({});
    await flush();
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].details.fallback.fallbackModel, "test/retry");
    assert.ok(h.messages[0].details.undeliveredMessages.some((item: any) => item.messageId === acceptedPrimary.details.messageId &&
      item.sessionFile === started.details.sessionFile));
    assert.ok(h.messages[0].content.includes(started.details.sessionFile), "failed primary pending records identify their explicit resume path");
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
  });

  it("releases the worker slot after fallback launch failure and interruption finalization", async (t) => {
    const h = setup(t);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG,
      agents: { worker: { model: "test/primary", modelFallback: "test/retry" } } });
    await h.call("subagent", { agent: "worker", task: "work" });
    runtime.lifecycle.createSurface = async () => { throw new Error("retry failed"); };
    h.watches[0].done.resolve({ exitCode: 1 });
    await flush();
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
    assert.match(h.messages[0].details.errorMessage, /Fallback launch failed: retry failed/);
    runtime.lifecycle.createSurface = async () => "bg:interrupt";
    const next = await h.call("subagent", { agent: "worker", task: "work again" });
    const run = runtime.runningSubagents.get(next.details.id)!;
    run.interruption = { actor: { kind: "parent" } as any, requestedAt: Date.now() };
    h.watches[1].done.resolve({ interrupted: true });
    await flush();
    assert.equal(h.watches.length, 2, "interrupted worker must not fall back");
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
  });

  it("refuses unsaved identities before subprocess launch and releases allocated surfaces and reservations", async (t) => {
    const h = setup(t);
    const registryPath = join(h.artifactDir(), "subagent-registry.json");
    mkdirSync(registryPath, { recursive: true }); // Atomic rename cannot replace a directory.
    const spawn = await h.call("subagent", { agent: "worker", name: "Unsaved", task: "work" });
    assertError(spawn, /startup failed/);
    assert.equal(h.commands.length, 0, "no process may start without a saved handle");
    assert.equal(h.closed.length, 1);
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
    assert.equal(runtime.reservedNames.size, 0);
    const file = h.session("unsaved-path", "worker");
    const resume = await h.call("subagent_message", { sessionPath: file, message: "work" });
    assertError(resume, /Resume startup failed/);
    assert.equal(h.commands.length, 0);
    assert.equal(h.closed.length, 2);
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
    assert.equal(runtime.reservedNames.size, 0);
    rmSync(registryPath, { recursive: true });
    const next = await h.call("subagent", { agent: "worker", name: "Unsaved", task: "retry" });
    assert.equal(next.details.status, "started");
  });

  it("persists before sending commands and rolls failed resumes back without removing other handles", async (t) => {
    const h = setup(t);
    const file = h.session("saved", "worker", "Saved");
    h.session("unrelated", "scout", "Unrelated");
    const before = readNameRegistry(h.artifactDir());
    runtime.lifecycle.sendLongCommand = async () => {
      assert.equal(readNameRegistry(h.artifactDir()).Saved.sessionFile, file);
      h.completeClaims();
      throw new Error("command failed after registration");
    };
    assertError(await h.call("subagent_message", { name: "Saved", message: "fail" }), /command failed after registration/);
    assert.deepEqual(readNameRegistry(h.artifactDir()), before);
    assert.equal(admissionCount("worker"), 0);
  });

  it("keys worker slots to canonical parent identity and permits different parents to run workers", async (t) => {
    const h = setup(t);
    const originalParent = { ...h.parent };
    const first = await h.call("subagent", { agent: "worker", name: "SameName", task: "first parent" });
    const alias = join(h.dir, "parent-alias.jsonl");
    symlinkSync(originalParent.file, alias);
    h.parent.file = alias;
    assertError(await h.call("subagent", { agent: "worker", task: "alias race" }), /"worker" profile \(maxConcurrent: 1\)/);
    h.parent.file = join(h.dir, "parent-two.jsonl"); h.parent.id = "parent-two";
    writeFileSync(h.parent.file, JSON.stringify({ type: "session", id: h.parent.id }) + "\n");
    const second = await h.call("subagent", { agent: "worker", name: "SameName", task: "second parent" });
    assert.equal(second.details.status, "started");
    assert.equal(admissionCount("worker"), 2);
    h.parent.file = originalParent.file; h.parent.id = originalParent.id;
    assertError(await h.call("subagent_interrupt", { id: second.details.id }), /in this parent session/);
    const cancelled = await h.call("subagent_interrupt", { name: "SameName" });
    assert.equal(cancelled.details.id, first.details.id);
    assert.equal(cancelled.details.status, "interrupt_requested");
    assert.ok(runtime.runningSubagents.get(first.details.id)?.interruption);
    assert.equal(runtime.runningSubagents.get(second.details.id)?.interruption, undefined);
  });

  it("captures resume parent before awaits and releases worker ownership after command failure cleanup", async (t) => {
    const h = setup(t);
    const file = h.session("resume-parent", "worker");
    const originalParent = { ...h.parent };
    const start = gate<string>();
    runtime.lifecycle.createSurface = async () => start.promise;
    const resumed = h.call("subagent_message", { sessionPath: file, message: "followup" });
    h.parent.file = join(h.dir, "changed-parent.jsonl"); h.parent.id = "changed-parent";
    start.resolve("bg:captured");
    const launched = await resumed;
    assert.ok(launched.details.launchScriptFile.includes(join("artifacts", originalParent.id)));
    assert.equal(readNameRegistry(join(h.dir, "artifacts", originalParent.id))["resume-parent"].sessionFile, file);
    assert.deepEqual(readNameRegistry(h.artifactDir()), {});
    h.parent.file = originalParent.file; h.parent.id = originalParent.id;
    h.watches[0].done.resolve({});
    await flush();
    const cleanup = gate<void>();
    const cleanupEntered = gate<void>();
    runtime.lifecycle.closeSurface = async (surface) => {
      h.closed.push(surface); cleanupEntered.resolve(); await cleanup.promise;
      h.completeClaims();
    };
    runtime.lifecycle.sendLongCommand = async () => { throw new Error("resume command failed"); };
    const failed = h.call("subagent_message", { sessionPath: file, message: "fail" });
    await cleanupEntered.promise;
    assertError(await h.call("subagent", { agent: "worker", task: "cleanup race" }), /"worker" profile \(maxConcurrent: 1\)/);
    assert.equal(admissionCount("worker"), 1);
    cleanup.resolve();
    assertError(await failed, /Resume startup failed: resume command failed/);
    assert.equal(admissionCount("worker"), 0);
    assert.equal(runtime.sessionReservations.size, 0);
    assert.equal(runtime.reservedNames.size, 0);
  });

  it("preserves Claude spawning ownership but rejects live, finished, and loadout-based messaging", async (t) => {
    const h = setup(t);
    writeFileSync(join(h.dir, "config", "agents", "worker.md"), "---\nname: worker\nmax-concurrent: 1\ncli: claude\n---\nClaude test profile\n");
    const spawned = await h.call("subagent", { agent: "worker", name: "Claude", task: "work" });
    assert.equal(spawned.details.status, "started");
    assert.equal(readSubagentLoadout(spawned.details.sessionFile)?.cli, "claude");
    assert.equal(admissionCount("worker"), 1);
    assertError(await h.call("subagent_message", { name: "Claude", message: "unsupported" }), /Claude CLI.*do not support durable/);
    h.watches[0].done.resolve({});
    await flush();
    assert.equal(admissionCount("worker"), 0);
    assertError(await h.call("subagent_message", { name: "Claude", message: "finished unsupported" }), /Claude CLI.*do not support durable/);
    const recorded = h.session("claude-snapshot");
    const loadout = { ...readSubagentLoadout(recorded)!, cli: "claude" as const };
    writeSubagentLoadout(recorded, loadout);
    assertError(await h.call("subagent_message", { sessionPath: recorded, message: "cannot replay as Pi" }), /cannot be replayed as Pi/);
    assert.throws(() => runtime.buildResumeCommandParts(recorded, loadout, { artifactDir: h.artifactDir(), name: "Claude" }), /cannot be replayed as Pi/);
    assert.equal(h.surfaces.length, 1, "rejected Claude messaging never launches a substitute Pi writer");
  });

  it("retains writer and worker claims when command startup or teardown cannot prove termination", async (t) => {
    const h = setup(t);
    runtime.lifecycle.sendLongCommand = async () => { throw new Error("ambiguous submission"); };
    runtime.lifecycle.closeSurface = async () => { throw new Error("cannot stop live wrapper"); };
    const failed = await h.call("subagent", { agent: "worker", name: "Held", task: "work" });
    assertError(failed, /ownership retained/);
    assert.match(failed.details.error, /cannot stop live wrapper/);
    assert.equal(admissionCount("worker"), 1);
    assert.equal(runtime.sessionReservations.size, 1);
    assertError(await h.call("subagent", { agent: "worker", task: "unsafe replacement" }), /"worker" profile \(maxConcurrent: 1\)/);
    const [file, reservation] = [...runtime.sessionReservations][0];
    assert.ok(reservation.owner);
    assert.throws(() => claimSession(file, "foreign-replacement"), /starting writer/);
  });

  it("admits custom profiles up to independent limits of two and three, scoped to each parent", async (t) => {
    const h = setup(t);
    h.profile("reviewer", 2);
    h.profile("auditor", 3);
    const start = gate<string>();
    runtime.lifecycle.createSurface = async (name, opts) => {
      h.surfaces.push({ name, sessionFile: opts!.sessionFile! });
      return start.promise;
    };
    const launches = [
      h.call("subagent", { agent: "reviewer", name: "worker", task: "one" }),
      h.call("subagent", { agent: "reviewer", task: "two" }),
      ...[1, 2, 3].map((i) => h.call("subagent", { agent: "auditor", task: `audit ${i}` })),
    ];
    assert.equal(admissionCount("reviewer"), 2);
    assert.equal(admissionCount("auditor"), 3);
    assertError(await h.call("subagent", { agent: "reviewer", task: "excess" }), /maxConcurrent: 2/);
    assertError(await h.call("subagent", { agent: "auditor", task: "excess" }), /maxConcurrent: 3/);
    assert.equal(h.surfaces.length, 5, "rejection happens before awaiting surface creation");
    const originalParent = { ...h.parent };
    h.parent.file = join(h.dir, "independent-parent.jsonl"); h.parent.id = "independent-parent";
    writeFileSync(h.parent.file, JSON.stringify({ type: "session", id: h.parent.id }) + "\n");
    launches.push(h.call("subagent", { agent: "reviewer", name: "worker", task: "independent" }));
    assert.equal(runtime.getProfileAdmissionCount(runtime.canonicalSessionPath(h.parent.file), "reviewer"), 1);
    h.parent.file = originalParent.file; h.parent.id = originalParent.id;
    start.resolve("bg:parallel");
    assert.ok((await Promise.all(launches)).every((result) => result.details.status === "started"));
    h.watches[0].done.resolve({});
    await flush();
    assert.equal(runtime.getProfileAdmissionCount(runtime.canonicalSessionPath(originalParent.file), "reviewer"), 1);
    assert.equal((await h.call("subagent", { agent: "reviewer", task: "replacement" })).details.status, "started");
  });

  it("counts unlimited profiles before a live profile or settings limit is lowered", async (t) => {
    const h = setup(t);
    for (let i = 0; i < 3; i++) assert.equal((await h.call("subagent", { agent: "reviewer", task: "unlimited" })).details.status, "started");
    assert.equal(admissionCount("reviewer"), 3);
    h.profile("reviewer", 2);
    assertError(await h.call("subagent", { agent: "reviewer", task: "profile now finite" }), /maxConcurrent: 2/);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { reviewer: { maxConcurrent: 1 } } });
    assertError(await h.call("subagent", { agent: "reviewer", task: "settings stricter" }), /maxConcurrent: 1/);
    assert.equal(runtime.runningSubagents.size, 3, "lowering policy never kills existing runs");
    const active = await h.call("subagent_message", { name: "reviewer", message: "same run" });
    assert.equal(active.details.status, "queued");
    assert.equal(admissionCount("reviewer"), 3);
    h.watches[0].done.resolve({}); h.watches[1].done.resolve({});
    await flush();
    assert.equal(admissionCount("reviewer"), 1);
    assertError(await h.call("subagent", { agent: "reviewer", task: "still at limit" }), /maxConcurrent: 1/);
    h.watches[2].done.resolve({});
    await flush();
    assert.equal(admissionCount("reviewer"), 0);
    assert.equal((await h.call("subagent", { agent: "reviewer", task: "available" })).details.status, "started");
  });

  it("honors an explicit null override and restores the profile cap when the override is absent", async (t) => {
    const h = setup(t);
    h.profile("reviewer", 1);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { reviewer: { maxConcurrent: null } } });
    for (let i = 0; i < 3; i++) assert.equal((await h.call("subagent", { agent: "reviewer", task: "explicit unlimited" })).details.status, "started");
    const recorded = h.session("unlimited-resume", "reviewer");
    assert.equal((await h.call("subagent_message", { sessionPath: recorded, message: "explicit unlimited resume" })).details.status, "started");
    assert.equal(admissionCount("reviewer"), 4);
    runtime.getSubagentsConfigState().replace(DEFAULT_SUBAGENTS_CONFIG);
    assertError(await h.call("subagent", { agent: "reviewer", task: "profile restored" }), /maxConcurrent: 1/);
    assert.equal(runtime.runningSubagents.size, 4);
  });

  it("uses current profile and parent override policy on resume without changing the frozen sandbox", async (t) => {
    const h = setup(t);
    const files = ["one", "two", "three"].map((name) => h.session(name, "reviewer"));
    const snapshots = files.map((file) => {
      const snapshot = { ...readSubagentLoadout(file)!, identity: "Frozen identity", model: "test/frozen", thinking: "low" };
      writeSubagentLoadout(file, snapshot);
      return snapshot;
    });
    h.profile("reviewer", 2);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG,
      agents: { reviewer: { maxConcurrent: 1, tools: [], model: "test/new", thinking: "high" } } });
    assert.equal((await h.call("subagent_message", { sessionPath: files[0], message: "resume" })).details.status, "started");
    assertError(await h.call("subagent_message", { sessionPath: files[1], message: "blocked" }), /"reviewer" profile \(maxConcurrent: 1\)/);
    runtime.getSubagentsConfigState().replace(DEFAULT_SUBAGENTS_CONFIG);
    assert.equal((await h.call("subagent_message", { sessionPath: files[1], message: "profile cap" })).details.status, "started");
    assertError(await h.call("subagent_message", { sessionPath: files[2], message: "blocked" }), /maxConcurrent: 2/);
    h.profile("reviewer", 3);
    assert.equal((await h.call("subagent_message", { sessionPath: files[2], message: "updated profile" })).details.status, "started");
    assert.equal(admissionCount("reviewer"), 3);
    for (let i = 0; i < files.length; i++) assert.deepEqual(readSubagentLoadout(files[i]), snapshots[i]);
    for (const command of h.commands) {
      assert.match(command, /test\/frozen/);
      assert.match(command, /read,ask_question/);
      assert.doesNotMatch(command, /test\/new/);
    }
    assert.equal((await h.call("subagent", { agent: "worker", task: "independent role" })).details.status, "started");
  });

  it("keeps a generic fallback's original admission when policy tightens, releasing only that run", async (t) => {
    const h = setup(t);
    h.profile("reviewer", 2);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG,
      agents: { reviewer: { model: "test/primary", modelFallback: "test/retry" } } });
    await h.call("subagent", { agent: "reviewer", name: "Retry", task: "fallback" });
    await h.call("subagent", { agent: "reviewer", name: "Peer", task: "peer" });
    const fallbackStart = gate<string>();
    runtime.lifecycle.createSurface = async () => fallbackStart.promise;
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { reviewer: { maxConcurrent: 1 } } });
    h.watches[0].done.resolve({ exitCode: 1 });
    await flush();
    assert.equal(admissionCount("reviewer"), 2);
    assertError(await h.call("subagent", { agent: "reviewer", task: "blocked during fallback startup" }), /maxConcurrent: 1/);
    const join = h.call("subagent_message", { name: "Retry", message: "joined retry" });
    fallbackStart.resolve("bg:retry");
    assert.equal((await join).details.status, "queued");
    await flush();
    assert.equal(admissionCount("reviewer"), 2, "fallback and startup join do not reserve extra slots");
    h.watches[2].done.resolve({});
    await flush();
    assert.equal(admissionCount("reviewer"), 1, "only the fallback admission was released");
    assertError(await h.call("subagent", { agent: "reviewer", task: "peer still at limit" }), /maxConcurrent: 1/);
    h.watches[1].done.resolve({});
    await flush();
    assert.equal(admissionCount("reviewer"), 0);
  });

  it("retains a custom profile admission after ambiguous fallback startup cleanup", async (t) => {
    const h = setup(t);
    h.profile("reviewer", 1);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG,
      agents: { reviewer: { model: "test/primary", modelFallback: "test/retry" } } });
    await h.call("subagent", { agent: "reviewer", task: "fallback" });
    runtime.lifecycle.sendLongCommand = async () => { throw new Error("ambiguous retry command"); };
    runtime.lifecycle.closeSurface = async () => { throw new Error("cannot stop retry"); };
    h.watches[0].done.resolve({ exitCode: 1 });
    await flush();
    assert.equal(admissionCount("reviewer"), 1);
    assert.equal(runtime.sessionReservations.size, 1);
    assert.match(h.messages[0].details.errorMessage, /ownership retained/);
    assertError(await h.call("subagent", { agent: "reviewer", task: "unsafe replacement" }), /maxConcurrent: 1/);
  });

  it("releases only a failed custom-profile startup while another admitted run stays active", async (t) => {
    const h = setup(t);
    h.profile("reviewer", 2);
    const failedStart = gate<string>();
    let calls = 0;
    runtime.lifecycle.createSurface = async () => ++calls === 1 ? failedStart.promise : "bg:peer";
    const failed = h.call("subagent", { agent: "reviewer", task: "will fail" });
    assert.equal((await h.call("subagent", { agent: "reviewer", task: "peer" })).details.status, "started");
    assert.equal(admissionCount("reviewer"), 2);
    failedStart.reject(new Error("surface failed"));
    assertError(await failed, /surface failed/);
    assert.equal(admissionCount("reviewer"), 1);
    assert.equal((await h.call("subagent", { agent: "reviewer", task: "replacement" })).details.status, "started");
    assertError(await h.call("subagent", { agent: "reviewer", task: "full" }), /maxConcurrent: 2/);
  });

  it("makes admission release idempotent without decrementing a peer or later reservation", (t) => {
    const h = setup(t);
    const parent = runtime.canonicalSessionPath(h.parent.file);
    const release = runtime.reserveProfileAdmission(parent, "reviewer", { maxConcurrent: 2 });
    const peer = runtime.reserveProfileAdmission(parent, "reviewer", { maxConcurrent: 2 });
    release(); release();
    assert.equal(admissionCount("reviewer"), 1);
    const next = runtime.reserveProfileAdmission(parent, "reviewer", { maxConcurrent: 2 });
    release();
    assert.equal(admissionCount("reviewer"), 2);
    peer(); next(); peer(); next();
    assert.equal(runtime.profileAdmissions.size, 0);
  });

  it("applies saved-parent profile limits to Claude CLI spawns, including explicit unlimited", async (t) => {
    const h = setup(t);
    h.profile("reviewer", undefined, "claude");
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { reviewer: { maxConcurrent: 2 } } });
    await h.call("subagent", { agent: "reviewer", task: "cli one" });
    await h.call("subagent", { agent: "reviewer", task: "cli two" });
    assertError(await h.call("subagent", { agent: "reviewer", task: "cli excess" }), /maxConcurrent: 2/);
    assert.equal(admissionCount("reviewer"), 2);
    h.profile("reviewer", 1, "claude");
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { reviewer: { maxConcurrent: null } } });
    assert.equal((await h.call("subagent", { agent: "reviewer", task: "cli unlimited" })).details.status, "started");
    assert.equal(admissionCount("reviewer"), 3);
    assertError(await h.call("subagent_message", { name: "reviewer", message: "unsupported" }), /Claude CLI.*do not support durable/);
  });

  it("fails closed on a present empty higher-priority limit at spawn and resume", async (t) => {
    const h = setup(t);
    const file = h.session("invalid-profile", "reviewer");
    mkdirSync(join(h.dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(h.dir, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\nmax-concurrent: \n---\nInvalid\n");
    assertError(await h.call("subagent", { agent: "reviewer", task: "refuse uncapped fallback" }), /Invalid max-concurrent/);
    assert.ok(runtime.discoverAgentDefinitions().find((agent) => agent.name === "reviewer")?.maxConcurrentError);
    assertError(await h.call("subagent_message", { sessionPath: file, message: "refuse uncapped fallback" }), /Invalid max-concurrent/);
    assert.equal(h.surfaces.length, 0);
    assert.equal(runtime.profileAdmissions.size, 0);
    runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { reviewer: { maxConcurrent: null } } });
    assertError(await h.call("subagent", { agent: "reviewer", task: "invalid profile cannot be bypassed" }), /Invalid max-concurrent/);
    assert.equal((await h.call("subagent", { agent: "scout", task: "unrelated valid role" })).details.status, "started");
    h.profile("reviewer", 2);
    const defs = runtime.loadAgentDefaults("reviewer")!;
    assert.ok(defs.maxConcurrentError, "invalid project definition shadows a finite global definition too");
  });

  it("lets valid higher-priority definitions shadow invalid lower-priority limits", async (t) => {
    const h = setup(t);
    writeFileSync(join(h.dir, "config", "agents", "reviewer.md"), "---\nname: reviewer\nmax-concurrent: garbage\n---\nInvalid lower priority\n");
    mkdirSync(join(h.dir, ".pi", "agents"), { recursive: true });
    writeFileSync(join(h.dir, ".pi", "agents", "reviewer.md"), "---\nname: reviewer\nmax-concurrent: 2\ntools: read\n---\nValid higher priority\n");
    const discovered = runtime.discoverAgentDefinitions().find((agent) => agent.name === "reviewer")!;
    assert.equal(discovered.maxConcurrent, 2);
    assert.equal(discovered.maxConcurrentError, undefined);
    assert.equal(runtime.loadAgentDefaults("reviewer")?.maxConcurrent, 2);
    await h.call("subagent", { agent: "reviewer", task: "one" });
    await h.call("subagent", { agent: "reviewer", task: "two" });
    assertError(await h.call("subagent", { agent: "reviewer", task: "excess" }), /maxConcurrent: 2/);
  });

  it("reserves spawn session identity before surface creation so a path caller joins, not relaunches", async (t) => {
    const h = setup(t);
    const start = gate<string>();
    runtime.lifecycle.createSurface = async (name, opts) => {
      h.surfaces.push({ name, sessionFile: opts!.sessionFile! });
      // Simulate a visible session file while the surface startup is gated.
      writeFileSync(opts!.sessionFile!, JSON.stringify({ type: "session", id: "visible" }) + "\n");
      return start.promise;
    };
    const spawn = h.call("subagent", { agent: "worker", name: "Visible", task: "initial" });
    const resume = h.call("subagent_message", { sessionPath: h.surfaces[0].sessionFile, message: "joined" });
    assert.equal(h.surfaces.length, 1);
    assert.equal(admissionCount("worker"), 1, "startup join does not consume another admission");
    start.resolve("bg:visible");
    const [a, b] = await Promise.all([spawn, resume]);
    assert.equal(a.details.id, b.details.id);
    assert.equal(b.details.status, "queued");
    assert.equal(h.watches.length, 1);
    assert.equal(admissionCount("worker"), 1, "the active path join still owns exactly one admission");
  });
});
