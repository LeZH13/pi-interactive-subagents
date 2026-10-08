import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DefaultPackageManager, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { hasBash, resolveBashGuardExtension, validateBashGuardExtension, validateShellSelection } from "../pi-extension/subagents/bash-guard.ts";
import { __test__ as runtime } from "../pi-extension/subagents/index.ts";
import { readSubagentLoadout, writeSubagentLoadout, type SubagentLoadout } from "../pi-extension/subagents/session.ts";
import { configureGuard, createGuardPackage } from "./helpers/bash-guard.ts";

const loadout: SubagentLoadout = { agent: "worker", toolAllowlist: "read,bash,codemode,ask_question",
  toolExtensionPaths: ["builtin:codemode"], model: null, thinking: null, systemPromptMode: null,
  identity: null, spawnable: [], autoExit: true, cwd: null, agentDir: null };

function temporary<T>(run: (directory: string) => T): T {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "subagent-bash-guard-")));
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  try {
    const result = run(directory);
    if (result instanceof Promise) return result.finally(cleanup) as T;
    cleanup();
    return result;
  } catch (error) { cleanup(); throw error; }
}

describe("required subagent bash-guard", () => {
  it("resolves a configured installed local package through Pi without loading its factory", () => temporary(async (dir) => {
    const { root, extension } = createGuardPackage(dir);
    // If resolution imports the extension, this throws; resource resolution must only inspect paths.
    writeFileSync(extension, "throw new Error('must not load in parent');\n");
    const agentDir = join(dir, "agent");
    configureGuard(agentDir, root);
    assert.equal(await resolveBashGuardExtension(dir, agentDir), extension);
  }));

  it("fails rather than install or fall back when the guard is missing", () => temporary(async (dir) => {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    await assert.rejects(resolveBashGuardExtension(dir, agentDir), /not configured and installed.*pi install/);
    configureGuard(agentDir, join(dir, "missing"));
    await assert.rejects(resolveBashGuardExtension(dir, agentDir), /Cannot launch bash-enabled subagent/);
  }));

  it("rejects old and prerelease versions rather than silently enabling prompts", () => temporary(async (dir) => {
    for (const version of ["0.2.1", "0.3.0-beta.1", "invalid"]) {
      const { root } = createGuardPackage(dir, version);
      const agentDir = join(dir, "agent");
      configureGuard(agentDir, root);
      await assert.rejects(resolveBashGuardExtension(dir, agentDir), /does not support enforced deny mode/);
    }
  }));

  it("prefers project packages and fails on an incompatible project guard", () => temporary(async (dir) => {
    const user = createGuardPackage(join(dir, "user"));
    const project = createGuardPackage(join(dir, "project"));
    const agentDir = join(dir, "agent");
    configureGuard(agentDir, user.root);
    mkdirSync(join(dir, ".pi"));
    writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ packages: [project.root] }));
    assert.equal(await resolveBashGuardExtension(dir, agentDir), project.extension);
    createGuardPackage(join(dir, "project"), "0.2.1");
    await assert.rejects(resolveBashGuardExtension(dir, agentDir), /does not support enforced deny mode/);
  }));

  it("rejects an undeclared guard source and a missing pinned file", () => temporary((dir) => {
    const { extension, root } = createGuardPackage(dir);
    assert.equal(validateBashGuardExtension(extension), extension);
    const undeclared = join(root, "other.ts");
    writeFileSync(undeclared, "export default () => {};\n");
    assert.throws(() => validateBashGuardExtension(undeclared), /not declared/);
    rmSync(extension);
    assert.throws(() => validateBashGuardExtension(extension), /pinned guard extension is unavailable/);
  }));

  it("pins and replays the guard first, including codemode, without rediscovery", () => temporary((dir) => {
    const { extension } = createGuardPackage(dir);
    const file = join(dir, "session.jsonl");
    const pinned = { ...loadout, bashGuardExtensionPath: extension };
    writeSubagentLoadout(file, pinned);
    assert.deepEqual(readSubagentLoadout(file), pinned);
    const { parts } = runtime.buildResumeCommandParts(file, readSubagentLoadout(file)!, { artifactDir: dir, name: "worker" });
    assert.deepEqual(parts.slice(0, 3), ["pi", "-e", `'${extension}'`]);
    assert.ok(parts.includes("--no-extensions"));
    assert.ok(parts.includes("--offline"));
    assert.ok(parts.includes("'builtin:codemode'"));
    assert.ok(parts.includes("'read,bash,codemode,ask_question'"));
    rmSync(extension);
    assert.throws(() => runtime.buildResumeCommandParts(file, pinned, { artifactDir: dir, name: "worker" }), /pinned guard extension is unavailable/);
  }));

  it("offline child resource loading skips missing packages but loads the pinned local guard", () => temporary(async (dir) => {
    const { extension } = createGuardPackage(dir);
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:guard-resolution-missing-test@0.0.1"] }));
    const prototype = DefaultPackageManager.prototype;
    const previousMethod = Object.getOwnPropertyDescriptor(prototype, "installParsedSource")!;
    const previousOffline = process.env.PI_OFFLINE;
    let installs = 0;
    Object.defineProperty(prototype, "installParsedSource", { ...previousMethod, value: async () => {
      installs++;
      throw new Error("Unexpected package installation");
    } });
    process.env.PI_OFFLINE = "1";
    try {
      const loader = new DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: SettingsManager.create(dir, agentDir),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [extension] });
      await loader.reload();
      assert.equal(installs, 0);
      assert.deepEqual(loader.getExtensions().errors, []);
      assert.ok(loader.getExtensions().extensions.some((entry) => entry.path === extension));
    } finally {
      Object.defineProperty(prototype, "installParsedSource", previousMethod);
      if (previousOffline === undefined) delete process.env.PI_OFFLINE;
      else process.env.PI_OFFLINE = previousOffline;
    }
  }));

  it("refuses bash snapshots without a pinned guard instead of migrating them", () => {
    assert.throws(() => runtime.applySandboxToParts(["pi"], loadout, { artifactDir: tmpdir(), name: "worker" }), /no pinned bash-guard source/);
  });

  it("leaves safe_bash independent and rejects granting both shell policies", () => {
    assert.equal(hasBash("safe_bash,ask_question"), false);
    assert.equal(hasBash(null), false);
    assert.equal(hasBash("bash,codemode"), true);
    assert.throws(() => validateShellSelection(["bash", "safe_bash"]), /not both/);
    assert.throws(() => runtime.validateSubagentTools(["bash", "safe_bash"], process.cwd()), /not both/);
    validateShellSelection(["safe_bash"]);
    const parts = ["pi"];
    runtime.applySandboxToParts(parts, { ...loadout, toolAllowlist: "safe_bash,ask_question", toolExtensionPaths: [] }, { artifactDir: tmpdir(), name: "researcher" });
    assert.ok(parts.includes("'safe_bash,ask_question'"));
    assert.equal(parts.some((part) => part.includes("bash-guard")), false);
  });
});
