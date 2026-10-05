import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  authorizeLaunch, claimSession, drainInbox, enqueueMessage, finalizeSession, openSession,
  pendingMessages, protocolDir, readSessionCompletion, recordCompletion, withSessionLock,
} from "../pi-extension/subagents/protocol.ts";
import {
  cleanOrphanArtifactDirs, findOrphanArtifactDirs, hasExtensionArtifacts,
  SUBAGENT_MANAGED_MARKER_FILE, writeArtifactOwnershipMarker,
} from "../pi-extension/subagents/session.ts";
import { backgroundExitCode, createBackgroundSurface } from "../pi-extension/subagents/background.ts";
import { closeSurface, pollForExit, sendLongCommand, shellEscape } from "../pi-extension/subagents/surface.ts";
import { __test__ as runtime } from "../pi-extension/subagents/index.ts";

function fixture(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-completion-cleanup-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const artifact = join(dir, "artifacts", "orphan");
  const subagents = join(artifact, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeArtifactOwnershipMarker(artifact, "orphan");
  writeFileSync(join(artifact, "subagent-registry.json"), "{}");
  const file = join(subagents, "child.jsonl");
  const owner = claimSession(file, "original", true);
  writeFileSync(file, '{"type":"session","id":"child"}\n');
  writeFileSync(`${file}.loadout.json`, "{}");
  const control = protocolDir(file);
  const archive = join(control, "completions", `${owner.ownerToken}.json`);
  const clean = () => cleanOrphanArtifactDirs(dir, { minAgeMs: 0 });
  const retained = () => {
    assert.equal(existsSync(file), true);
    assert.equal(existsSync(`${file}.loadout.json`), true);
    assert.equal(existsSync(join(artifact, SUBAGENT_MANAGED_MARKER_FILE)), true);
    assert.equal(existsSync(join(artifact, "subagent-registry.json")), true);
    assert.equal(findOrphanArtifactDirs(dir, { minAgeMs: 0 }).length, 1);
    assert.equal(hasExtensionArtifacts(artifact), true);
  };
  return { dir, artifact, subagents, file, owner, control, archive, clean, retained };
}
function open(file: string, owner: Parameters<typeof openSession>[1]) {
  authorizeLaunch(file, owner); openSession(file, owner);
}

// A real background launch and real outer wrapper must exit before ownership changes or polling starts.
async function exited(surface: string) {
  const deadline = Date.now() + 5000;
  while (backgroundExitCode(surface) === null || backgroundExitCode(surface) === undefined) {
    assert.ok(Date.now() < deadline, "real wrapper did not exit");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(backgroundExitCode(surface), 0);
}

describe("immutable completion polling across successor claims", () => {
  for (const richError of [false, true]) {
    it(`returns the original ${richError ? "rich error" : "success"} after a real background wrapper and successor claim`, async (t) => {
      const h = fixture(t);
      const failure = { type: "error", runId: h.owner.runId, ownerToken: h.owner.ownerToken,
        errorMessage: "  provider unavailable 🦊\nsecond line  ", stopReason: "error", createdAt: Date.now() };
      const source = richError
        ? `require('node:fs').writeFileSync(process.argv[1],${JSON.stringify(JSON.stringify(failure))})`
        : "process.exit(0)";
      const command = `exec ${shellEscape(process.execPath)} -e ${shellEscape(source)} ${shellEscape(`${h.file}.exit`)}`;
      const surface = createBackgroundSurface(`completion-${h.owner.ownerToken}`, join(h.dir, "background.log"));
      t.after(() => closeSurface(surface));
      await sendLongCommand(surface, runtime.wrapCommandWithCompletion(command, `${h.file}.complete`, h.owner.runId, h.owner.ownerToken),
        { scriptPath: join(h.dir, "wrapper.sh") });
      await exited(surface);
      assert.equal(readSessionCompletion(h.file, h.owner)?.exitCode, 0);
      const next = claimSession(h.file, "successor");
      assert.equal(existsSync(`${h.file}.complete`), false);
      runtime.clearRunSignals(h.file);
      assert.equal(existsSync(`${h.file}.exit`), false);
      // Give the successor its own live records; the late watcher must leave all of them intact.
      writeFileSync(`${h.file}.exit`, JSON.stringify({ ...failure, runId: next.runId, ownerToken: next.ownerToken, errorMessage: "successor failure" }));
      recordCompletion(h.file, next, 2);
      const paths = [join(h.control, "owner.json"), `${h.file}.complete`, `${h.file}.exit`];
      const before = paths.map((path) => readFileSync(path, "utf8"));
      const expected = richError
        ? { reason: "error", exitCode: 1, errorMessage: failure.errorMessage }
        : { reason: "done", exitCode: 0 };
      for (const backend of [surface, "%surviving-terminal-pane"]) {
        assert.deepEqual(await pollForExit(backend, AbortSignal.timeout(1000), {
          interval: 5, sessionFile: h.file,
          runId: h.owner.runId, ownerToken: h.owner.ownerToken,
        }), expected);
      }
      assert.equal(finalizeSession(h.file, h.owner), true);
      assert.deepEqual(paths.map((path) => readFileSync(path, "utf8")), before);
    });
  }

  it("validates archived token, run, timestamp, exit code and rich-error identity without trusting the live marker", (t) => {
    const h = fixture(t); recordCompletion(h.file, h.owner, 0);
    const done = JSON.parse(readFileSync(h.archive, "utf8"));
    for (const mutation of [
      { ownerToken: "foreign" }, { runId: "foreign" }, { completedAt: "yesterday" }, { exitCode: "0" },
      { error: { type: "error", ownerToken: h.owner.ownerToken, runId: "foreign", errorMessage: "wrong run" } },
    ]) {
      writeFileSync(h.archive, JSON.stringify({ ...done, ...mutation }));
      assert.equal(readSessionCompletion(h.file, h.owner), undefined);
    }
    writeFileSync(h.archive, JSON.stringify(done));
    assert.equal(readSessionCompletion(h.file, { ...h.owner, runId: "foreign" }), undefined);
    assert.equal(readSessionCompletion(h.file, { ...h.owner, ownerToken: "../../foreign" }), undefined);
    assert.equal(readSessionCompletion(h.file, h.owner)?.exitCode, 0);
  });
});

describe("safe completed protocol group cleanup", () => {
  it("removes completed control history, inbox, ACKs and session sidecars", (t) => {
    const h = fixture(t); open(h.file, h.owner);
    const item = enqueueMessage(h.file, h.owner, "retained body 🧭");
    drainInbox(h.file, h.owner, { branch: [], deliver: () => "question", close: true });
    recordCompletion(h.file, h.owner, 0);
    const next = claimSession(h.file, "second"); open(h.file, next);
    enqueueMessage(h.file, next, "unacknowledged body");
    recordCompletion(h.file, next, 0);
    assert.equal(existsSync(join(h.control, "acks", `${item.messageId}.json`)), true);
    const result = h.clean();
    assert.ok(result.cleanedFilesCount >= 10);
    assert.equal(existsSync(h.control), false);
    assert.equal(existsSync(h.artifact), false);
    assert.deepEqual(findOrphanArtifactDirs(h.dir, { minAgeMs: 0 }), []);
  });

  it("retains a busy completed group under the same mutex, then cleans after release", (t) => {
    const h = fixture(t); recordCompletion(h.file, h.owner, 0);
    withSessionLock(h.file, () => {
      assert.equal(h.clean().cleanedFilesCount, 0);
      h.retained();
      assert.equal(existsSync(h.archive), true);
      assert.equal(existsSync(`${h.file}.complete`), true);
    });
    h.clean(); assert.equal(existsSync(h.artifact), false);
  });

  it("retains active groups and launch artifacts, leaving their pending inbox recoverable by explicit resume", (t) => {
    const h = fixture(t); open(h.file, h.owner);
    const item = enqueueMessage(h.file, h.owner, "recover this message");
    mkdirSync(join(h.artifact, "subagent-scripts"));
    const script = join(h.artifact, "subagent-scripts", "child.sh"); writeFileSync(script, "keep");
    assert.equal(h.clean().cleanedFilesCount, 0); h.retained();
    assert.equal(readFileSync(script, "utf8"), "keep");
    assert.equal(pendingMessages(h.file)[0].messageId, item.messageId);
    recordCompletion(h.file, h.owner, 0);
    const next = claimSession(h.file, "recovered"); open(h.file, next);
    const delivered: string[] = [];
    drainInbox(h.file, next, { branch: [], deliver: (message) => { delivered.push(message.body); return "question"; }, close: true });
    assert.deepEqual(delivered, [item.body]);
    recordCompletion(h.file, next, 0);
    h.clean(); assert.equal(existsSync(h.artifact), false);
  });

  for (const ambiguous of ["missing owner", "wrong archived run", "malformed owner"]) {
    it(`retains a ${ambiguous} group and its ownership marker until repaired`, (t) => {
      const h = fixture(t); recordCompletion(h.file, h.owner, 0);
      const ownerPath = join(h.control, "owner.json");
      const beforeOwner = readFileSync(ownerPath, "utf8");
      const beforeArchive = readFileSync(h.archive, "utf8");
      if (ambiguous === "missing owner") rmSync(ownerPath);
      else if (ambiguous === "malformed owner") writeFileSync(ownerPath, "{}");
      else writeFileSync(h.archive, JSON.stringify({ ...JSON.parse(beforeArchive), runId: "foreign" }));
      assert.equal(h.clean().cleanedFilesCount, 0); h.retained();
      assert.equal(existsSync(`${h.file}.complete`), true);
      writeFileSync(ownerPath, beforeOwner); writeFileSync(h.archive, beforeArchive);
      const next = claimSession(h.file, "recovered");
      recordCompletion(h.file, next, 0);
      h.clean(); assert.equal(existsSync(h.artifact), false);
    });
  }

  for (const foreign of ["file", "directory", "symlink", "completion symlink", "control symlink", "loadout symlink"]) {
    it(`preserves the complete group containing a foreign ${foreign}, without following targets`, (t) => {
      const h = fixture(t); recordCompletion(h.file, h.owner, 0);
      const outside = join(h.dir, "outside"); mkdirSync(outside);
      const target = join(outside, "keep.json"); writeFileSync(target, "foreign content");
      let unexpected = join(h.control, "foreign.json");
      if (foreign === "file") writeFileSync(unexpected, "{}");
      else if (foreign === "directory") { unexpected = join(h.control, "foreign"); mkdirSync(unexpected); writeFileSync(join(unexpected, "keep"), "foreign"); }
      else if (foreign === "symlink") symlinkSync(target, unexpected);
      else if (foreign === "completion symlink") {
        unexpected = h.archive;
        writeFileSync(target, readFileSync(h.archive)); rmSync(h.archive); symlinkSync(target, h.archive);
      } else if (foreign === "control symlink") {
        // A familiar control name never authorizes traversal of an external directory.
        rmSync(h.control, { recursive: true }); unexpected = h.control; symlinkSync(outside, h.control, "dir");
      } else {
        unexpected = `${h.file}.loadout.json`; rmSync(unexpected); symlinkSync(target, unexpected);
      }
      const targetBefore = readFileSync(target, "utf8");
      assert.equal(h.clean().cleanedFilesCount, 0); h.retained();
      assert.equal(existsSync(unexpected), true);
      assert.equal(readFileSync(target, "utf8"), targetBefore);
      assert.equal(readdirSync(outside).length, 1);
    });
  }
});
