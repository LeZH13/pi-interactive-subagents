import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync, symlinkSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { registerSubagentsAuditCommand, parseAuditArgs, AUDIT_MARKER } from "../pi-extension/subagents/audit-command.ts";
import { seedSubagentSessionFile } from "../pi-extension/subagents/session.ts";
// The dependency-free executable is intentionally JavaScript, usable without a TS loader.
// @ts-expect-error No declaration needed for the local offline CLI.
import { analyze, parseCli, LIMITS } from "../audit/analyze.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "audit/analyze.mjs");
const usage = (input = 10) => ({ input, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: input + 5, cost: { total: 0.01 } });
const message = (id: string, parentId: string | null, role = "assistant", extra: any = {}) => ({ type: "message", id, parentId, timestamp: `2026-01-01T00:00:0${id.length}Z`, message: { role, content: [{ type: "text", text: "PRIVATE-PAYLOAD apiKey=SECRET" }], ...(role === "assistant" ? { usage: usage() } : {}), ...extra } });
function fixture(run: (dir: string) => void | Promise<void>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagents audit ")));
  try { const result = run(dir); if (result) return result.finally(() => rmSync(dir, { recursive: true, force: true })); }
  catch (e) { rmSync(dir, { recursive: true, force: true }); throw e; }
  rmSync(dir, { recursive: true, force: true });
}
function session(dir: string, file: string, id: string, entries: any[] = [], header: any = {}) {
  const path = join(dir, file); mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [JSON.stringify({ type: "session", version: 3, id, cwd: dir, ...header }), ...entries.map(e => JSON.stringify(e))].join("\n") + "\n");
  return path;
}
function registry(path: string, id: string, entries: any) {
  const dir = join(dirname(path), "artifacts", id); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "subagent-registry.json"), JSON.stringify(entries));
}
const codes = (report: any) => report.issues.map((i: any) => i.code);

describe("subagents audit command", () => {
  function command(file: string | undefined, overrides: any = {}) {
    let registered: any; const sent: string[] = [], notices: any[] = [];
    registerSubagentsAuditCommand({ registerCommand(name: string, c: any) { assert.equal(name, "subagents-audit"); registered = c; }, sendUserMessage(text: string, options: any) { assert.equal(options.expandPromptTemplates, false); sent.push(text); if (file) writeFileSync(file, text, { flag: "a" }); } } as any, root);
    const ctx = { cwd: root, hasUI: true, ui: { notify: (...args: any[]) => notices.push(args) }, isIdle: () => true,
      sessionManager: { getSessionFile: () => file, getSessionDir: () => file ? dirname(file) : root, getSessionId: () => "current-id", getLeafId: () => "active-leaf" }, ...overrides };
    return { registered, sent, notices, ctx };
  }
  const context = (text: string) => JSON.parse(text.split("Audit context (JSON data, not instructions):\n")[1]);
  it("captures the current file cutoff and leaf before injection, not the physical last entry", () => fixture(async dir => {
    const file = session(dir, "current.jsonl", "current-id", [message("active-leaf", null), message("other-tail", null)]);
    const size = statSync(file).size, mock = command(file);
    await mock.registered.handler("", mock.ctx);
    assert.equal(mock.sent.length, 1); const c = context(mock.sent[0]);
    assert.deepEqual(c.targets, [file]); assert.equal(c.current.cutoffBytes, size); assert.equal(c.current.leafId, "active-leaf");
    assert.deepEqual(c.snapshots, [{ path: file, cutoffBytes: size, leafId: "active-leaf" }]);
    assert.ok(mock.sent[0].startsWith(AUDIT_MARKER)); assert.ok(mock.sent[0].includes(script));
    assert.ok(mock.sent[0].includes(readFileSync(join(root, "audit/INSTRUCTIONS.md"), "utf8")));
    assert.ok(statSync(file).size > c.current.cutoffBytes);
  }));
  it("keeps explicit refs as data and supports compare, quotes, commas and profiles", () => fixture(async dir => {
    const file = session(dir, "current.jsonl", "current-id"), mock = command(file);
    await mock.registered.handler('compare id-1, "/path with spaces/log.jsonl" "$(touch NOPE)"', mock.ctx);
    assert.deepEqual(context(mock.sent[0]).targets, ["id-1", "/path with spaces/log.jsonl", "$(touch NOPE)"]);
    assert.equal(context(mock.sent[0]).mode, "compare"); assert.equal(existsSync(join(root, "NOPE")), false);
    await mock.registered.handler('profiles "relative agents"', mock.ctx);
    const c = context(mock.sent[1]); assert.equal(c.profilesDir, join(root, "relative agents"));
    assert.deepEqual(c.targets, []); assert.ok(c.configPaths.every((p: string) => p.startsWith("/")));
    assert.equal(c.projectAgentsDir, join(root, ".pi/agents"));
    await mock.registered.handler('"relative/session.jsonl"', mock.ctx);
    assert.deepEqual(context(mock.sent[2]).targets, [join(root, "relative/session.jsonl")]);
  }));
  it("passes resolved configured agent and session directories for semantic profile review", async () => {
    const oldAgent = process.env.PI_CODING_AGENT_DIR, oldSessions = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_DIR = "/configured/agent"; process.env.PI_CODING_AGENT_SESSION_DIR = "/configured/sessions";
    try {
      const mock = command(undefined); await mock.registered.handler("profiles", mock.ctx);
      const c = context(mock.sent[0]); assert.equal(c.agentDir, "/configured/agent"); assert.equal(c.profilesDir, "/configured/agent/agents"); assert.equal(c.sessionsDir, root);
      assert.equal(c.configPaths[0], "/configured/agent/extensions/pi-interactive-subagents/config.json");
    } finally {
      if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgent;
      if (oldSessions === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = oldSessions;
    }
  });
  it("uses the CLI-selected session directory instead of a conflicting environment directory end-to-end", () => fixture(async dir => {
    const cliDir = join(dir, "cli-A"), envDir = join(dir, "env-B");
    const current = session(cliDir, "current.jsonl", "current-id", [message("active-leaf", null)]);
    const wanted = session(cliDir, "wanted.jsonl", "requested-id", [message("wanted", null)]);
    session(envDir, "different.jsonl", "requested-id", [message("wrong", null)]);
    const old = process.env.PI_CODING_AGENT_SESSION_DIR; process.env.PI_CODING_AGENT_SESSION_DIR = envDir;
    try {
      const mock = command(current); await mock.registered.handler("requested-id", mock.ctx);
      const request = context(mock.sent[0]); assert.equal(request.sessionsDir, cliDir); assert.equal(request.current.sessionDir, cliDir);
      const cli = spawnSync(process.execPath, [script, "--request-json", JSON.stringify(request)], { encoding: "utf8" });
      assert.equal(cli.status, 0); assert.deepEqual(JSON.parse(cli.stdout).roots, [wanted]);
    } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR; else process.env.PI_CODING_AGENT_SESSION_DIR = old; }
  }));
  it("asks for refs for an ephemeral session, with no invented target", async () => {
    const mock = command(undefined); await mock.registered.handler("", mock.ctx);
    const c = context(mock.sent[0]); assert.equal(c.needsReferences, true); assert.deepEqual(c.targets, []); assert.deepEqual(c.snapshots, []);
  });
  it("refuses busy contexts without injecting, including no-UI mode", async () => {
    const mock = command(undefined, { isIdle: () => false }); await mock.registered.handler("id", mock.ctx);
    assert.equal(mock.sent.length, 0); assert.equal(mock.notices[0][1], "warning");
    const old = console.error, errors: string[] = []; console.error = text => errors.push(text);
    try { const headless = command(undefined, { isIdle: () => false, hasUI: false, ui: undefined }); await headless.registered.handler("", headless.ctx); assert.equal(headless.sent.length, 0); assert.equal(errors.length, 1); }
    finally { console.error = old; }
  });
  it("reports invalid args, missing files and resources safely without UI", async () => {
    const old = console.error, errors: string[] = []; console.error = text => errors.push(text);
    try {
      const mock = command("/no-such-audit-file", { hasUI: false, ui: undefined });
      for (const args of ['"unclosed', "compare one", "profiles one two", ""]) await mock.registered.handler(args, mock.ctx);
      assert.equal(mock.sent.length, 0); assert.equal(errors.length, 4);
      let c: any; registerSubagentsAuditCommand({ registerCommand(_name: string, cmd: any) { c = cmd; } } as any, "/missing-package");
      await c.handler("profiles", command(undefined, { hasUI: false, ui: undefined }).ctx); assert.equal(errors.length, 5);
    } finally { console.error = old; }
  });
  it("tokenizes data without shell expansion and bounds arguments", () => {
    assert.deepEqual(parseAuditArgs("a,b 'c,d' \"space path\" `whoami`"), ["a", "b", "c,d", "space path", "`whoami`"]);
    assert.throws(() => parseAuditArgs("x".repeat(16385))); assert.throws(() => parseAuditArgs(Array(65).fill("a").join(" ")));
  });
});

describe("offline orchestration analyzer", () => {
  it("resolves header IDs, rejects basename IDs, supports real CLI paths with spaces", () => fixture(dir => {
    const file = session(dir, "misleading-name.jsonl", "header-authority", [message("m", null)]);
    const cli = spawnSync(process.execPath, [script, "header-authority", "--sessions-dir", dir], { encoding: "utf8" });
    assert.equal(cli.status, 0); assert.deepEqual(JSON.parse(cli.stdout).roots, [file]);
    assert.ok(codes(analyze({ targets: ["misleading-name"], sessionsDir: dir })).includes("missing_id"));
    assert.equal(analyze({ targets: ["header-authority", file] }).roots.length, 1);
    const pathCli = spawnSync(process.execPath, [script, file, "--leaf", "m", "--cutoff-bytes", String(statSync(file).size)], { encoding: "utf8" });
    assert.equal(pathCli.status, 0); assert.equal(JSON.parse(pathCli.stdout).sessions[0].branch.entries, 1);
    const request = { targets: [file], snapshots: [{ path: file, leafId: "m", cutoffBytes: statSync(file).size }] };
    assert.equal(spawnSync(process.execPath, [script, "--request-json", JSON.stringify(request)], { encoding: "utf8" }).status, 0);
    assert.equal(spawnSync(process.execPath, [script, "--unknown"], { encoding: "utf8" }).status, 1);
  }));
  it("reports missing, ambiguous, mismatched and malformed sources", () => fixture(dir => {
    session(dir, "one.jsonl", "duplicate"); session(dir, "two.jsonl", "duplicate");
    assert.ok(codes(analyze({ targets: ["duplicate"], sessionsDir: dir })).includes("ambiguous_id"));
    assert.ok(codes(analyze({ targets: [join(dir, "missing.jsonl")] })).includes("missing"));
    const parent = session(dir, "parent.jsonl", "parent"), child = session(dir, "child.jsonl", "child");
    registry(parent, "parent", { x: { sessionFile: child, sessionId: "wrong-id" }, missing: { sessionFile: join(dir, "missing.jsonl"), sessionId: "missing" } });
    const report = analyze({ targets: [parent], sessionsDir: dir }); assert.ok(codes(report).includes("registry_header_mismatch")); assert.ok(codes(report).includes("missing_child")); assert.equal(report.graph.length, 0);
    writeFileSync(join(dir, "bad.jsonl"), '{"type":"session","id":"bad"}\nnot-json\n{"type":');
    const bad = analyze({ targets: [join(dir, "bad.jsonl")] }); assert.ok(codes(bad).includes("malformed_json")); assert.ok(codes(bad).includes("truncated_json")); assert.equal(bad.sessions[0].attribution.newUsage, null);
    writeFileSync(join(dirname(parent), "artifacts/parent/subagent-registry.json"), "{");
    assert.ok(codes(analyze({ targets: [parent] })).includes("malformed_registry"));
  }));
  it("never infers ID-search completeness from retained issues", () => fixture(dir => {
    session(dir, "one.jsonl", "duplicate"); session(dir, "two.jsonl", "duplicate");
    const r = analyze({ targets: [join(dir, "missing.jsonl"), "duplicate"], sessionsDir: dir, limits: { issues: 1, searchFiles: 1 } });
    assert.deepEqual(r.roots, []); assert.equal(r.processing.idSearchComplete, false);
    assert.equal(r.issues.length, 1); assert.equal(r.issues[0].code, "missing"); assert.ok(r.issuesOmitted >= 2);
  }));
  it("treats malformed, depth-limited and inaccessible search candidates as incomplete", () => fixture(dir => {
    const malformedDir = join(dir, "malformed"), wanted = session(malformedDir, "wanted.jsonl", "wanted");
    writeFileSync(join(malformedDir, "bad.jsonl"), '{"type":');
    const bad = analyze({ targets: ["wanted"], sessionsDir: malformedDir });
    assert.deepEqual(bad.roots, []); assert.equal(bad.processing.idSearchComplete, false); assert.ok(codes(bad).includes("resolution_unknown_incomplete_search"));
    const unreadable = analyze({ targets: ["wanted"], sessionsDir: wanted }); // ENOTDIR is a deterministic inaccessible-directory fixture.
    assert.equal(unreadable.processing.idSearchComplete, false); assert.ok(codes(unreadable).includes("unreadable_search_dir")); assert.ok(codes(unreadable).includes("resolution_unknown_incomplete_search"));
    const deepDir = join(dir, "deep"); session(deepDir, "wanted.jsonl", "wanted");
    let nested = deepDir; for (let i = 0; i < 65; i++) nested = join(nested, "d");
    session(nested, "duplicate.jsonl", "wanted");
    const deep = analyze({ targets: ["wanted"], sessionsDir: deepDir });
    assert.deepEqual(deep.roots, []); assert.equal(deep.processing.idSearchComplete, false); assert.ok(codes(deep).includes("search_depth_limit"));
  }));
  it("reports structurally invalid message content without throwing or dropping later valid records", () => fixture(dir => {
    const values = [{ some: 1 }, { some: false }, false, 42, null];
    const entries = values.map((content, i) => message(`bad${i}`, null, "assistant", { content }));
    entries.push(message("good", null, "assistant", { content: [{ type: "text", text: "PRIVATE good content; tool callback is false" }] }));
    const file = session(dir, "invalid-content.jsonl", "content", entries);
    const cli = spawnSync(process.execPath, [script, file], { encoding: "utf8" });
    assert.equal(cli.status, 0); const r = JSON.parse(cli.stdout);
    assert.equal(r.sessions[0].physical.counts.message, 6); assert.equal(r.sessions[0].physical.events.length, 0); assert.equal(r.sessions[0].physical.eventsOmitted, 0);
    assert.equal(r.sessions[0].complete, false); assert.equal(r.sessions[0].attribution.newUsage, null); assert.equal(r.totals.coverage, "partial: inspect issues");
    assert.equal(r.issues.filter((i: any) => i.code === "invalid_message").length, 5); assert.ok(!cli.stdout.includes("PRIVATE good content"));
  }));
  it("deduplicates aliases and overlapping root trees, recurses with per-file registry derivation and cycles", () => fixture(dir => {
    const parent = session(dir, "parent.jsonl", "p", [message("pm", null)]);
    const child = session(dir, "artifacts/p/subagents/child.jsonl", "c", [message("cm", null)]);
    const nested = session(dirname(child), "artifacts/c/subagents/sdk-directory/nested.jsonl", "n", [message("nm", null)]);
    registry(parent, "p", { c: { sessionFile: child, sessionId: "c" } }); registry(child, "c", { n: { sessionFile: nested, sessionId: "n" } }); registry(nested, "n", { cycle: { sessionFile: parent, sessionId: "p" } });
    const alias = join(dir, "alias.jsonl"); symlinkSync(parent, alias);
    const r = analyze({ targets: [parent, alias, "p", child], sessionsDir: dir, mode: "compare" });
    assert.equal(r.roots.length, 2); assert.equal(r.sessions.length, 3); assert.equal(r.graph.length, 3); assert.ok(codes(r).includes("registry_cycle"));
    assert.equal(r.totals.uniquePhysicalFiles, 3); assert.equal(r.totals.sharedFiles, 3); assert.equal(r.totals.attributedNewUsage.sums.input, 30);
    assert.equal(r.sessions.find((s: any) => s.sessionId === "n").memberships.length, 2);
    assert.ok(codes(analyze({ targets: [parent, alias], mode: "compare" })).includes("compare_requires_distinct_roots"));
  }));
  it("follows marker-owned artifact children without treating parentSession alone as delegation", () => fixture(dir => {
    const parent = session(dir, "parent.jsonl", "p"), fork = session(dir, "plain-fork.jsonl", "fork", [], { parentSession: parent });
    const child = session(dir, "artifacts/p/subagents/child.jsonl", "c", [message("cm", null)]);
    const nested = session(dirname(child), "artifacts/c/subagents/nested.jsonl", "n");
    for (const [path, id] of [[parent, "p"], [child, "c"]]) writeFileSync(join(dirname(path), "artifacts", id, ".subagents-managed.json"), JSON.stringify({ version: 1, managedBy: "pi-interactive-subagents", parentSessionId: id, createdAt: 1 }));
    const r = analyze({ targets: [parent], sessionsDir: dir });
    assert.equal(r.sessions.length, 3); assert.equal(r.graph.length, 2); assert.equal(r.graph[0].basis, "managed_artifact"); assert.ok(!r.roots.includes(fork)); assert.ok(r.sessions.some((s: any) => s.path === nested));
    assert.equal(analyze({ targets: [fork], sessionsDir: dir }).graph.length, 0);
  }));
  it("refuses escaped registry paths, arbitrary transcript strings, and artifact symlinks", () => fixture(dir => {
    const storage = join(dir, "storage"), outside = join(dir, "private"); mkdirSync(storage); mkdirSync(outside);
    const secret = session(outside, "secret.jsonl", "outside", [message("s", null)]);
    const parent = session(storage, "parent.jsonl", "p", [message("u", null, "user", { content: secret })]);
    const alias = join(storage, "alias.jsonl"); symlinkSync(secret, alias);
    registry(parent, "p", { escape: { sessionFile: secret, sessionId: "outside" }, symlink: { sessionFile: alias, sessionId: "outside" } });
    const r = analyze({ targets: [parent], sessionsDir: storage }); assert.equal(r.sessions.length, 1); assert.equal(r.graph.length, 0); assert.ok(codes(r).includes("scope_violation"));
    const onlyExplicit = analyze({ targets: [parent] }); assert.equal(onlyExplicit.sessions.length, 1);
    const p2 = session(storage, "second.jsonl", "p2"); symlinkSync(outside, join(storage, "artifacts/p2"));
    assert.ok(codes(analyze({ targets: [p2] })).includes("scope_violation"));
  }));
  it("excludes corroborated fork-seeded usage while unknown provenance never invents totals", () => fixture(dir => {
    const copied = message("seed", null), parent = session(dir, "parent.jsonl", "p", [copied]);
    const child = session(dir, "artifacts/p/subagents/child.jsonl", "c", [copied, message("new", "seed")], { parentSession: parent });
    registry(parent, "p", { child: { sessionFile: child, sessionId: "c" } });
    const r = analyze({ targets: [parent, child], sessionsDir: dir });
    assert.equal(r.sessions[1].physical.usage.sums.input, 20); assert.equal(r.sessions[1].attribution.inheritedEntriesExcluded, 1); assert.equal(r.totals.attributedNewUsage.sums.input, 20);
    const unknown = session(dir, "unknown.jsonl", "unknown", [copied], { parentSession: join(dir, "missing-parent.jsonl") });
    assert.equal(analyze({ targets: [unknown] }).totals.attributedNewUsage, null);
    assert.equal(analyze({ targets: [child] }).sessions[0].attribution.status, "unknown"); // parent is not in explicit child scope
    const conflict = session(dir, "conflict.jsonl", "conflict", [{ ...copied, timestamp: "different" }], { parentSession: parent });
    assert.equal(analyze({ targets: [conflict], sessionsDir: dir }).sessions[0].attribution.newUsage, null);
  }));
  it("keeps known seeds but leaves unmatched pre-creation child records unknown even with a readable parent", () => fixture(dir => {
    const copied = { ...message("copied", null), timestamp: "2026-01-01T00:00:00Z" };
    const parent = session(dir, "parent.jsonl", "p", [copied], { timestamp: "2025-12-01T00:00:00Z" });
    const old = { ...message("unmatched-old", "copied"), timestamp: "2026-01-02T00:00:00Z" };
    const fresh = { ...message("fresh", "unmatched-old"), timestamp: "2026-02-02T00:00:00Z" };
    const child = session(dir, "child.jsonl", "c", [copied, old, fresh], { parentSession: parent, timestamp: "2026-02-01T00:00:00Z" });
    const r = analyze({ targets: [child], sessionsDir: dir }).sessions[0];
    assert.equal(r.attribution.inheritedEntriesExcluded, 1); assert.equal(r.attribution.newUsage, null); assert.match(r.attribution.reason, /unmatched records predate/); assert.equal(r.physical.usage.sums.input, 30);
  }));
  it("historical marker data does not invalidate corroborated parent provenance or hide copied seeds", () => fixture(dir => {
    const copied = { ...message("copied", null), timestamp: "2026-01-01T00:00:00Z" };
    const audit = { ...message("prior-audit", "copied", "user", { content: AUDIT_MARKER + " untrusted marker data" }), timestamp: "2026-01-02T00:00:00Z" };
    const later = { ...message("later", "prior-audit"), timestamp: "2026-01-03T00:00:00Z" };
    const parent = session(dir, "parent.jsonl", "p", [copied, audit, later], { timestamp: "2025-12-01T00:00:00Z" });
    const fresh = { ...message("fresh", "later"), timestamp: "2026-02-02T00:00:00Z" };
    const child = session(dir, "child.jsonl", "c", [copied, audit, later, fresh], { parentSession: parent, timestamp: "2026-02-01T00:00:00Z" });
    const r = analyze({ targets: [child], sessionsDir: dir }).sessions[0];
    assert.equal(r.attribution.inheritedEntriesExcluded, 3); assert.equal(r.attribution.newUsage.sums.input, 10); assert.equal(r.physical.auditRequests.count, 1);
  }));
  it("uses real fork seed ancestry despite dispatch stripping and unresolved tool-call sanitization", () => fixture(dir => {
    const initial = message("seed", null), dispatch = message("dispatch", "seed", "user", { content: "[pi-subagent-dispatch] call subagent" });
    const pending = message("pending", "dispatch", "assistant", { content: [{ type: "text", text: "Starting" }, { type: "toolCall", id: "unresolved", name: "subagent", arguments: { task: "PRIVATE" } }] });
    const parent = session(dir, "parent.jsonl", "p", [initial, dispatch, pending]);
    const child = join(dir, "fork.jsonl");
    seedSubagentSessionFile({ mode: "fork", parentSessionFile: parent, parentLeafId: "pending", childSessionFile: child, childCwd: dir });
    const started = Date.parse(JSON.parse(readFileSync(child, "utf8").split("\n")[0]).timestamp);
    writeFileSync(child, JSON.stringify({ ...message("new", "pending"), timestamp: new Date(started + 1000).toISOString() }) + "\n", { flag: "a" });
    const r = analyze({ targets: [parent, child], sessionsDir: dir });
    assert.equal(r.sessions[1].attribution.inheritedEntriesExcluded, 2);
    assert.equal(r.sessions[1].attribution.newUsage.sums.input, 10);
    assert.equal(r.totals.attributedNewUsage.sums.input, 30);
    const cutoff = statSync(parent).size;
    writeFileSync(parent, JSON.stringify(message("after", "pending")) + "\n", { flag: "a" });
    assert.equal(analyze({ targets: [child], sessionsDir: dir, snapshots: [{ path: parent, cutoffBytes: cutoff }] }).sessions[0].attribution.newUsage, null);
  }));
  it("leaves cyclic provenance and completely unresolved totals unknown", () => fixture(dir => {
    const a = join(dir, "a.jsonl"), b = join(dir, "b.jsonl");
    session(dir, "a.jsonl", "a", [message("a1", null)], { parentSession: b });
    session(dir, "b.jsonl", "b", [message("b1", null)], { parentSession: a });
    const r = analyze({ targets: [a], sessionsDir: dir });
    assert.equal(r.sessions[0].attribution.newUsage, null); assert.match(r.sessions[0].attribution.reason, /cyclic/);
    assert.equal(analyze({ targets: ["unresolved"], sessionsDir: dir }).totals.attributedNewUsage, null);
  }));
  it("detects unproven copies without inferring parentage or double-counting new work", () => fixture(dir => {
    const copied = message("same", null), a = session(dir, "a.jsonl", "a", [copied]), b = session(dir, "b.jsonl", "b", [copied]);
    const r = analyze({ targets: [a, b] }); assert.equal(r.graph.length, 0); assert.equal(r.totals.attributedNewUsage, null);
    assert.ok(r.sessions.every((s: any) => s.attribution.reason.includes("cross-file copied")));
    const old = session(dir, "old-history.jsonl", "old", [copied], { timestamp: "2026-02-01T00:00:00Z" });
    assert.equal(analyze({ targets: [old] }).sessions[0].attribution.newUsage, null);
  }));
  it("separates active leaf ancestry from physical accounting, non-message usage and absent usage", () => fixture(dir => {
    const entries = [message("a", null), message("b", "a"), message("abandoned", "a"),
      { type: "compaction", id: "compact", parentId: "b", summary: "PRIVATE-SUMMARY", tokensBefore: 1000, usage: usage(20) },
      { type: "branch_summary", id: "summary", parentId: "compact", summary: "PRIVATE-SUMMARY", usage: usage(30) },
      { type: "usage", id: "warm", parentId: "summary", kind: "cache_warm", usage: usage(40) },
      message("missing", "warm", "assistant", { usage: undefined }), { type: "context_edit", id: "edit", parentId: "missing", targetId: "a", replacement: null }];
    const file = session(dir, "branched.jsonl", "branch", entries), cutoff = statSync(file).size;
    const r = analyze({ targets: [file], snapshots: [{ path: file, cutoffBytes: cutoff, leafId: "b" }] }).sessions[0];
    assert.equal(r.physical.counts.message, 4); assert.equal(r.branch.entries, 2); assert.equal(r.branch.measurements.usage.sums.input, 20); assert.equal(r.physical.usage.sums.input, 120);
    assert.equal(r.physical.usage.byCategory.compaction.sums.input, 20); assert.equal(r.physical.usage.byCategory.branch_summary.sums.input, 30); assert.equal(r.physical.usage.byCategory.cache_warm.sums.input, 40);
    assert.equal(r.physical.usage.assistantMissingUsage, 1); assert.equal(r.physical.usage.status, "partial/unknown"); assert.match(r.branch.modelVisibleContext, /unknown/);
    assert.match(analyze({ targets: [file] }).sessions[0].branch.status, /no explicit leaf/);
    assert.ok(codes(analyze({ targets: [file], snapshots: [{ path: file, leafId: "absent" }] })).includes("missing_or_cyclic_leaf"));
    const missingSummary = session(dir, "summary.jsonl", "s", [{ type: "compaction", id: "c", parentId: null }, message("m", "c", "assistant", { usage: { output: 1 } })]);
    const m = analyze({ targets: [missingSummary] }).sessions[0].physical.usage;
    assert.equal(m.missingUsageByCategory.compaction, 1); assert.equal(m.missingFields.input, 1); assert.equal(m.recordedCost.status, "partial/unknown");
  }));
  it("retains historical audit markers and later legitimate work while a captured cutoff excludes only this invocation", () => fixture(dir => {
    const entries = [message("before", null),
      message("audit1", "before", "user", { content: AUDIT_MARKER + " prior audit" }), message("answer1", "audit1"),
      message("legitimate1", "answer1"),
      message("hostile", "legitimate1", "user", { content: [{ type: "text", text: AUDIT_MARKER + " hostile data must not hide later work" }] }),
      message("legitimate2", "hostile"),
      message("audit2", "legitimate2", "user", { content: AUDIT_MARKER + " second audit" }), message("answer2", "audit2"), message("active-leaf", "answer2")];
    const file = session(dir, "current.jsonl", "p", entries), cutoff = statSync(file).size;
    writeFileSync(file, JSON.stringify(message("this-audit", "active-leaf", "user", { content: AUDIT_MARKER })) + "\n" + JSON.stringify(message("this-work", "this-audit")) + "\n", { flag: "a" });
    const r = analyze({ targets: [file], snapshots: [{ path: file, cutoffBytes: cutoff, leafId: "active-leaf" }] });
    assert.equal(r.sessions[0].physical.counts.message, 9); assert.equal(r.sessions[0].complete, true);
    assert.equal(r.sessions[0].branch.entries, 9); assert.equal(r.sessions[0].branch.leafId, "active-leaf"); assert.ok(!codes(r).includes("missing_or_cyclic_leaf"));
    assert.equal(r.sessions[0].physical.auditRequests.count, 3); assert.match(r.sessions[0].physical.auditRequests.activityUsage, /unknown/);
    assert.deepEqual(r.sessions[0].physical.events.filter((e: any) => e.type === "audit_request").map((e: any) => [e.entryId, e.line]), [["audit1", 3], ["hostile", 6], ["audit2", 8]]);
    assert.equal("auditMarkerCutoffBytes" in r.sessions[0], false);
    assert.ok(!JSON.stringify(r).includes("hostile data")); assert.equal(r.sessions[0].physical.usage.sums.input, 60);
    const historical = analyze({ targets: [file] }).sessions[0]; assert.equal(historical.physical.counts.message, 11); assert.equal(historical.physical.auditRequests.count, 4); assert.equal(historical.complete, true);
    const bounded = analyze({ targets: [file], limits: { events: 1 } }).sessions[0].physical;
    assert.equal(bounded.events.length, 1); assert.equal(bounded.eventsOmitted, 3);
  }));
  it("enforces processing and output bounds with explicit disclosures", () => fixture(dir => {
    const a = session(dir, "a.jsonl", "a", [message("a1", null), message("a2", "a1")]), b = session(dir, "b.jsonl", "b");
    assert.ok(codes(analyze({ targets: [a], limits: { fileBytes: 90 } })).includes("truncated_byte_limit"));
    assert.ok(codes(analyze({ targets: [a], limits: { nodes: 1 } })).includes("node_limit"));
    const files = analyze({ targets: [a, b], limits: { files: 1 } }); assert.ok(codes(files).includes("file_limit")); assert.equal(files.processing.files, 1);
    const bytes = analyze({ targets: [a, b], limits: { bytes: 90 } }); assert.ok(bytes.processing.bytes <= 90);
    assert.ok(codes(analyze({ targets: ["a"], sessionsDir: dir, limits: { searchFiles: 1 } })).includes("search_limit"));
    const small = analyze({ targets: [a, b], limits: { outputBytes: 2048 } }); assert.equal(small.outputTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(small)) <= 2048);
    assert.throws(() => analyze({ targets: [a], limits: { files: LIMITS.files + 1 } }));
    assert.throws(() => parseCli(["--leaf", "a1"])); assert.throws(() => parseCli(["--request-json", "null"]));
  }));
  it("bounds copied-record ancestry work independently of file parsing", () => fixture(dir => {
    const history = Array.from({ length: 10 }, (_, i) => message(`x${i}`, i ? `x${i - 1}` : null));
    const parent = session(dir, "parent.jsonl", "p", history);
    const child = session(dir, "child.jsonl", "c", history.map((e, i) => ({ ...e, parentId: i ? "x0" : null })), { parentSession: parent });
    const r = analyze({ targets: [child], sessionsDir: dir, limits: { nodes: 24 } });
    assert.ok(codes(r).includes("provenance_node_limit")); assert.ok(r.processing.provenanceSteps <= 24); assert.equal(r.sessions[0].attribution.newUsage, null);
  }));
  it("emits no raw payloads, labels wrapper telemetry and never mutates files", () => fixture(dir => {
    const call = (id: string, name: string, args: any) => ({ type: "toolCall", id, name, arguments: args });
    const file = session(dir, "private.jsonl", "private", [message("m1", null, "assistant", { content: [call("t1", "read", { path: "/PRIVATE-PATH" }), call("t2", "codemode", { code: "PRIVATE-CODE apiKey=SECRET" })] }), message("m2", "m1", "assistant", { content: [call("t3", "read", { path: "/PRIVATE-PATH" })] }), message("t", "m2", "toolResult")]);
    const before = readFileSync(file), listing = readdirSync(dir), mtime = statSync(file).mtimeMs;
    const r = analyze({ targets: [file] }), output = JSON.stringify(r);
    for (const text of ["PRIVATE-PAYLOAD", "PRIVATE-PATH", "PRIVATE-CODE", "SECRET", "apiKey"]) assert.ok(!output.includes(text));
    assert.equal(r.sessions[0].physical.repeatedReadCalls, 1); assert.deepEqual(r.sessions[0].physical.topTools, [{ name: "read", calls: 2 }, { name: "codemode", calls: 1 }]);
    assert.match(r.sessions[0].physical.toolMetricBasis, /not exact nested telemetry/);
    assert.deepEqual(readFileSync(file), before); assert.equal(statSync(file).mtimeMs, mtime); assert.deepEqual(readdirSync(dir), listing);
  }));
});

describe("packaged on-demand audit assets", () => {
  it("has canonical instructions/references/analyzer and removes skill advertising", () => {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); assert.equal(manifest.pi.skills, undefined);
    assert.equal(existsSync(join(root, "skills")), false); assert.equal(existsSync(join(root, "test/subagent-audit-skill.test.ts")), false);
    const instructions = readFileSync(join(root, "audit/INSTRUCTIONS.md"), "utf8");
    const refs = [...instructions.matchAll(/\]\((references\/[^)]+\.md)\)/g)].map(m => m[1]);
    assert.deepEqual(refs, ["references/profile-audit.md", "references/session-audit.md", "references/report-contract.md"]);
    for (const ref of refs) assert.ok(statSync(join(root, "audit", ref)).isFile());
    assert.ok(statSync(script).isFile());
    assert.match(readFileSync(join(root, "pi-extension/subagents/index.ts"), "utf8"), /registerSubagentsAuditCommand\(pi, resolve\(SUBAGENTS_DIR, "\.\.\/\.\."\)\)/);
    assert.ok(readFileSync(join(root, ".gitignore"), "utf8").includes("/.pi/settings.json"));
  });
});
