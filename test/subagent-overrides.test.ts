import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getPowerShellConfig, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createSubagentsConfigState, DEFAULT_SUBAGENTS_CONFIG, loadSubagentsConfig,
  parseSubagentsConfig, serializeSubagentsConfig, type AgentOverride,
} from "../pi-extension/subagents/config.ts";
import { __test__ as runtime, registerToolExtension } from "../pi-extension/subagents/index.ts";
import { readSubagentLoadout, writeSubagentLoadout, loadoutSidecarPath } from "../pi-extension/subagents/session.ts";
import { closeSurface, getSurfaceBackendPreference, setSurfaceBackendPreference } from "../pi-extension/subagents/surface.ts";

function withTempDir<T>(run: (dir: string) => T): T {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-overrides-")));
  try {
    const result = run(dir);
    if (result instanceof Promise) return result.finally(() => rmSync(dir, { recursive: true, force: true })) as T;
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

const originalConfig = runtime.getSubagentsConfigState().get();
afterEach(() => {
  runtime.getSubagentsConfigState().replace(originalConfig);
  runtime.clearToolExtensions();
});

function setOverride(override: AgentOverride) {
  runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: { worker: override } });
}

describe("persisted subagent launch overrides", () => {
  it("round-trips all selections including explicit empties and a disabled fallback", () => {
    const agents = {
      inherited: {},
      disabled: { tools: [], skills: [], subagentAgents: [], modelFallback: null },
      explicit: { model: " provider/primary ", thinking: " high ", tools: [" read ", "read", "bash"], skills: ["review"], subagentAgents: ["scout"], modelFallback: " provider/retry " },
      parent: { modelFallback: "inherit" },
    };
    const parsed = parseSubagentsConfig({ agents });
    assert.deepEqual(parsed.agents, {
      disabled: agents.disabled,
      explicit: { ...agents.explicit, model: "provider/primary", thinking: "high", tools: ["read", "bash"], modelFallback: "provider/retry" },
      parent: agents.parent,
    });
    assert.deepEqual(parseSubagentsConfig(JSON.parse(serializeSubagentsConfig(parsed))), parsed);
    assert.equal(Object.hasOwn(parsed.agents.parent, "tools"), false);
  });

  it("rejects malformed new fields and unsupported paths", () => {
    for (const key of ["tools", "skills", "subagentAgents"]) {
      for (const value of [null, "read", ["read", 2], {}]) {
        assert.throws(() => parseSubagentsConfig({ agents: { worker: { [key]: value } } }), /must be an array of strings/);
      }
    }
    for (const value of [[], false, 2, {}]) {
      assert.throws(() => parseSubagentsConfig({ agents: { worker: { modelFallback: value } } }), /must be a string/);
    }
    assert.throws(() => parseSubagentsConfig({ agents: { worker: { spawnable: [] } } }), /unsupported key/);
    assert.throws(() => parseSubagentsConfig({ agents: { worker: { "model-fallback": "inherit" } } }), /unsupported key/);
  });

  it("updates one field without dropping unrelated overrides, and restores defaults by deleting fields", () => withTempDir((dir) => {
    const path = join(dir, "nested", "config.json");
    const state = createSubagentsConfigState(DEFAULT_SUBAGENTS_CONFIG, path);
    state.update((draft) => { draft.agents.worker = { tools: [], skills: [], subagentAgents: [], modelFallback: null }; });
    state.update((draft) => { draft.agents.worker.model = " provider/new "; });
    assert.deepEqual(loadSubagentsConfig(path).agents.worker, { tools: [], skills: [], subagentAgents: [], modelFallback: null, model: "provider/new" });
    state.update((draft) => { delete draft.agents.worker.model; delete draft.agents.worker.tools; });
    assert.deepEqual(state.get().agents.worker, { skills: [], subagentAgents: [], modelFallback: null });
    state.update((draft) => { draft.agents.worker = {}; });
    assert.deepEqual(loadSubagentsConfig(path).agents, {});
  }));

  it("keeps live state unchanged if an update cannot be validated or persisted", () => withTempDir((dir) => {
    const path = join(dir, "config.json");
    const state = createSubagentsConfigState(DEFAULT_SUBAGENTS_CONFIG, path);
    assert.throws(() => state.update((draft) => { draft.agents.worker = { tools: "read" } as any; }));
    assert.deepEqual(state.get(), DEFAULT_SUBAGENTS_CONFIG);
    writeFileSync(path, "not a directory");
    const blocked = createSubagentsConfigState(DEFAULT_SUBAGENTS_CONFIG, join(path, "config.json"));
    assert.throws(() => blocked.update((draft) => { draft.agents.worker = { skills: [] }; }));
    assert.deepEqual(blocked.get(), DEFAULT_SUBAGENTS_CONFIG);
  }));
});

describe("effective Pi launch selection", () => {
  const profile = { tools: "read,bash", skills: "review,audit", subagentAgents: ["scout", "researcher"], modelFallback: "provider/retry" };

  it("uses profiles for undefined arrays and parent active tools only when the profile is absent", () => {
    assert.deepEqual(runtime.resolveEffectiveAgentLoadout(profile, undefined, ["edit"], null), {
      tools: ["read", "bash"], skills: ["review", "audit"], subagentAgents: ["scout", "researcher"], modelFallback: "provider/retry",
    });
    const defaults = runtime.resolveEffectiveAgentLoadout(null, undefined, ["read", "bash", "subagent"], null);
    assert.equal(runtime.buildSubagentToolAllowlist(defaults.tools), "read,bash,ask_question");
    assert.deepEqual(defaults.subagentAgents, []);
  });

  it("preserves explicit empties and intersects delegation with the parent's pinned agents", () => {
    const empty = runtime.resolveEffectiveAgentLoadout(profile, { tools: [], skills: [], subagentAgents: [], modelFallback: null }, ["write"], null);
    assert.deepEqual(empty, { tools: [], skills: [], subagentAgents: [], modelFallback: null });
    assert.equal(runtime.buildSubagentToolAllowlist(empty.tools), "ask_question");
    const restricted = runtime.resolveEffectiveAgentLoadout(profile, { subagentAgents: ["worker", "scout", "scout"] }, [], new Set(["scout"]));
    assert.deepEqual(restricted.subagentAgents, ["scout"]);
    assert.deepEqual(runtime.resolveEffectiveAgentLoadout(profile, undefined, [], new Set()).subagentAgents, []);
    assert.equal(runtime.buildSubagentToolAllowlist(["subagent", "subagent_interrupt", "subagent_message", "subagents_list"]), "ask_question");
    assert.equal(runtime.buildSubagentToolAllowlist([], { grantSpawning: true }), "subagent,subagent_interrupt,subagent_message,subagents_list,ask_question");
  });

  it("treats the empty child allowlist environment as denied, not unrestricted", () => {
    const original = process.env.PI_SUBAGENT_ALLOWED;
    try {
      delete process.env.PI_SUBAGENT_ALLOWED;
      assert.equal(runtime.getSubagentAllowlist(), null);
      process.env.PI_SUBAGENT_ALLOWED = "";
      assert.deepEqual(runtime.getSubagentAllowlist(), new Set());
      process.env.PI_SUBAGENT_ALLOWED = "scout,researcher";
      assert.deepEqual(runtime.getSubagentAllowlist(), new Set(["scout", "researcher"]));
    } finally {
      if (original === undefined) delete process.env.PI_SUBAGENT_ALLOWED;
      else process.env.PI_SUBAGENT_ALLOWED = original;
    }
  });

  it("applies live fallback choices while retaining explicit model/thinking precedence and Claude defaults", () => {
    const params = { agent: "worker", task: "test" };
    const defaults = { model: "provider/profile:low", thinking: "medium", modelFallback: "provider/profile-retry" };
    const parent = { model: "provider/parent", thinking: "high" };
    setOverride({ model: "provider/custom", thinking: "max", modelFallback: null });
    assert.equal(runtime.resolveFallbackModelAndThinking(params, defaults, parent), undefined);
    setOverride({ model: "provider/custom", thinking: "max", modelFallback: "inherit" });
    assert.deepEqual(runtime.resolveFallbackModelAndThinking(params, defaults, parent), { model: "provider/parent", thinking: "max" });
    assert.deepEqual(runtime.resolveEffectiveModelAndThinking({ ...params, model: "provider/tool:high", thinking: "2048" }, defaults), { model: "provider/tool", thinking: "2048" });
    setOverride({ modelFallback: "provider/explicit" });
    assert.deepEqual(runtime.resolveFallbackModelAndThinking(params, defaults, parent), { model: "provider/explicit", thinking: "low" });
    setOverride({ modelFallback: null });
    assert.deepEqual(runtime.resolveFallbackModelAndThinking(params, { ...defaults, cli: "claude" }, parent), { model: "provider/profile-retry", thinking: "low" });
    setOverride({});
    assert.deepEqual(runtime.resolveFallbackModelAndThinking(params, defaults, parent), { model: "provider/profile-retry", thinking: "low" });
  });

  it("builds startup prompts only, preserving multiple skills and explicit empty selection", () => {
    assert.deepEqual(runtime.buildPiPromptArgs({ effectiveSkills: ["review", "audit"], taskDelivery: "artifact", taskArg: "@task.md" }), ["", "/skill:review", "/skill:audit", "@task.md"]);
    assert.deepEqual(runtime.buildPiPromptArgs({ effectiveSkills: [], taskDelivery: "artifact", taskArg: "@task.md" }), ["@task.md"]);
  });
});

describe("runtime catalogs and extension replay", () => {
  it("includes inactive reloadable tools, marks inline tools unavailable, and loads their actual sources", () => withTempDir((dir) => {
    const extension = join(dir, "custom.ts");
    writeFileSync(extension, "export default () => {};\n");
    const pi = {
      getAllTools: () => [
        { name: "read", description: "builtin", sourceInfo: { path: "builtin:read" } },
        { name: "inactive_custom", description: "custom", sourceInfo: { path: extension } },
        { name: "codemode", description: "code", sourceInfo: { path: "builtin:codemode" } },
        { name: "inline_tool", sourceInfo: { path: "<sdk:inline_tool>" } },
        { name: "web_search", sourceInfo: { path: "<inline:web>" } },
        { name: "subagent", sourceInfo: { path: extension } },
        { name: "ask_question", sourceInfo: { path: extension } },
      ],
      getCommands: () => [
        { source: "skill", name: "skill:review", description: "Review code" },
        { source: "extension", name: "not-a-skill" },
      ],
    } as unknown as ExtensionAPI;
    const tools = runtime.getSubagentToolCatalog(pi, dir);
    assert.deepEqual(tools.slice(0, 5).map(({ name, available }) => [name, available]), [
      ["read", true], ["inactive_custom", true], ["codemode", true], ["inline_tool", false], ["web_search", false],
    ]);
    assert.equal(tools.find((tool) => tool.name === "read")!.description, "builtin");
    assert.deepEqual(runtime.getSubagentSkillCatalog(pi), [{ name: "review", description: "Review code" }]);
    assert.equal(runtime.getToolExtensionPath("inactive_custom", dir), extension);
    assert.throws(() => runtime.validateSubagentTools(["inline_tool"], dir), /no reloadable backing extension/);
    assert.throws(() => runtime.validateSubagentTools(["web_search"], dir), /no reloadable backing extension/);
    registerToolExtension("manually_registered_override_test", extension);
    runtime.validateSubagentTools(["manually_registered_override_test"], dir);
    const parts: string[] = [];
    runtime.applySandboxToParts(parts, {
      agent: "worker", toolAllowlist: "inactive_custom,codemode,ask_question", model: null, thinking: null,
      systemPromptMode: null, identity: null, spawnable: [], autoExit: true, cwd: dir, agentDir: null,
    }, { artifactDir: dir, name: "worker" });
    assert.ok(parts.includes(`'${extension}'`));
    assert.ok(parts.includes("'builtin:codemode'"));
    assert.ok(parts.includes("--no-extensions"));
  }));

  it("offers missing built-ins and bundled safe_bash without widening inherited active defaults", () => withTempDir((dir) => {
    const pi = {
      getAllTools: () => [
        { name: "read", description: "Registered read metadata", sourceInfo: { path: "builtin:read" } },
        { name: "read", description: "Registered read metadata", sourceInfo: { path: "builtin:read" } },
        { name: "subagent", sourceInfo: { path: "builtin:subagent" } },
        { name: "subagent_interrupt", sourceInfo: { path: "builtin:subagent" } },
        { name: "subagent_message", sourceInfo: { path: "builtin:subagent" } },
        { name: "subagents_list", sourceInfo: { path: "builtin:subagent" } },
        { name: "ask_question", sourceInfo: { path: "builtin:ask_question" } },
      ],
      getActiveTools: () => ["read"],
    } as unknown as ExtensionAPI;
    const catalog = runtime.getSubagentToolCatalog(pi, dir);
    const byName = new Map(catalog.map((tool) => [tool.name, tool]));
    assert.equal(catalog.length, byName.size);
    assert.deepEqual([...byName.keys()], ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls", "codemode", "tool_search", "safe_bash"]);
    assert.equal(byName.get("read")!.description, "Registered read metadata");
    assert.equal(byName.get("bash")!.available, true);
    assert.equal(byName.get("codemode")!.available, true);
    assert.equal(byName.get("tool_search")!.available, true);
    assert.equal(byName.get("safe_bash")!.available, true);
    assert.match(byName.get("bash")!.description!, /bypasses safe_bash's command filters/);
    assert.match(byName.get("safe_bash")!.description!, /bypasses safe_bash's command filters/);
    let powerShellAvailable = false;
    try { getPowerShellConfig(); powerShellAvailable = true; } catch {}
    assert.equal(byName.get("powershell")!.available, powerShellAvailable);
    if (process.platform !== "win32") assert.equal(byName.get("powershell")!.available, false);
    const inherited = runtime.resolveEffectiveAgentLoadout(null, undefined, pi.getActiveTools(), null);
    assert.equal(runtime.buildSubagentToolAllowlist(inherited.tools), "read,ask_question");
    assert.equal(runtime.buildSubagentToolAllowlist(["bash", "safe_bash"]), "bash,safe_bash,ask_question");
  }));

  it("keeps registered safe_bash sources authoritative instead of substituting the bundled extension", () => withTempDir((dir) => {
    const catalog = runtime.getSubagentToolCatalog({ getAllTools: () => [
      { name: "safe_bash", description: "Registered SDK tool", sourceInfo: { path: "<sdk:safe_bash>" } },
    ] } as unknown as ExtensionAPI, dir);
    const safeBash = catalog.filter((tool) => tool.name === "safe_bash");
    assert.equal(safeBash.length, 1);
    assert.equal(safeBash[0].available, false);
    assert.match(safeBash[0].description!, /^Registered SDK tool/);
  }));

  it("freezes relative registered and metadata sources as absolute paths across child and fresh-parent cwd changes", () => withTempDir((dir) => {
    const originalCwd = process.cwd();
    const sourceDir = join(dir, "source");
    const childDir = join(dir, "child");
    const resumeDir = join(dir, "fresh-parent");
    for (const path of [sourceDir, childDir, resumeDir]) mkdirSync(path);
    const registeredPath = join(sourceDir, "relative.ts");
    const capturedPath = join(sourceDir, "captured.ts");
    writeFileSync(registeredPath, "export default () => {};\n");
    writeFileSync(capturedPath, "export default () => {};\n");
    try {
      process.chdir(sourceDir);
      registerToolExtension("relative_registered", "./relative.ts");
      registerToolExtension("relative_registered", registeredPath); // Same normalized source is idempotent.
      process.chdir(childDir);
      runtime.captureRuntimeToolExtensions({ getAllTools: () => [
        { name: "relative_captured", sourceInfo: { path: "./captured.ts", baseDir: sourceDir } },
      ] } as unknown as ExtensionAPI);
      const toolAllowlist = "relative_registered,relative_captured,codemode,ask_question";
      const toolExtensionPaths = runtime.snapshotToolExtensionPaths(toolAllowlist.split(","), childDir);
      assert.deepEqual(toolExtensionPaths, [registeredPath, capturedPath, "builtin:codemode"]);
      const loadout = {
        agent: "worker", toolAllowlist, toolExtensionPaths, model: null, thinking: null,
        systemPromptMode: null, identity: null, spawnable: [], autoExit: true, cwd: childDir, agentDir: null,
      };
      const initial: string[] = [];
      runtime.applySandboxToParts(initial, loadout, { artifactDir: dir, name: "worker" });
      assert.ok(initial.includes(`'${registeredPath}'`));
      assert.ok(initial.includes(`'${capturedPath}'`));
      const sessionFile = join(dir, "session.jsonl");
      writeSubagentLoadout(sessionFile, loadout);
      runtime.clearToolExtensions();
      process.chdir(resumeDir);
      assert.equal(runtime.getToolExtensionPath("relative_registered", childDir), undefined);
      assert.equal(runtime.getToolExtensionPath("relative_captured", childDir), undefined);
      const { parts } = runtime.buildResumeCommandParts(sessionFile, readSubagentLoadout(sessionFile)!, { artifactDir: dir, name: "worker" });
      assert.ok(parts.includes(`'${registeredPath}'`));
      assert.ok(parts.includes(`'${capturedPath}'`));
      assert.ok(parts.includes("'builtin:codemode'"));
      assert.deepEqual(readSubagentLoadout(sessionFile)!.toolExtensionPaths, toolExtensionPaths);
    } finally {
      process.chdir(originalCwd);
    }
  }));
});

describe("new launches versus persisted resumes", () => {
  it("launches with live overrides, updates the next launch, and never rewrites a resumed sandbox", async () => withTempDir(async (dir) => {
    const oldEnv = Object.fromEntries(["PATH", "PI_CODING_AGENT_DIR", "PI_SUBAGENT_ALLOWED", "PI_SUBAGENT_AGENT"].map((key) => [key, process.env[key]]));
    const oldBackend = getSurfaceBackendPreference();
    const runs: Awaited<ReturnType<typeof runtime.launchSubagent>>[] = [];
    const name = "override-launch-fixture";
    const agentDir = join(dir, "agent");
    const agentsDir = join(agentDir, "agents");
    const binDir = join(dir, "bin");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(binDir);
    const fakePi = join(binDir, "pi");
    writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
    chmodSync(fakePi, 0o755);
    writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\nmodel: provider/profile\nthinking: low\ntools: read,bash\nskills: default-skill\nsubagent_agents: scout,researcher\n---\nA fixture.\n`);
    const customExtension = join(dir, "launch-tool.ts");
    writeFileSync(customExtension, "export default () => {};\n");
    const parentSession = join(dir, "parent.jsonl");
    writeFileSync(parentSession, JSON.stringify({ type: "session", id: "parent", cwd: dir }) + "\n");
    const ctx = { cwd: dir, sessionManager: {
      getSessionFile: () => parentSession, getSessionId: () => "parent", getSessionDir: () => dir, getLeafId: () => null,
    } } as any;
    try {
      process.env.PATH = `${binDir}:${oldEnv.PATH}`;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      process.env.PI_SUBAGENT_ALLOWED = "scout";
      delete process.env.PI_SUBAGENT_AGENT;
      setSurfaceBackendPreference("background");
      runtime.captureRuntimeToolExtensions({ getAllTools: () => [{ name: "launch_custom", sourceInfo: { path: customExtension } }] } as unknown as ExtensionAPI);
      const configPath = join(dir, "overrides.json");
      const state = createSubagentsConfigState(DEFAULT_SUBAGENTS_CONFIG, configPath);
      state.update((draft) => { draft.agents[name] = {
        model: "provider/custom", thinking: "max", tools: ["launch_custom"], skills: ["review", "audit"],
        subagentAgents: ["scout", "researcher"], modelFallback: null,
      }; });
      runtime.getSubagentsConfigState().replace(loadSubagentsConfig(configPath));
      const first = await runtime.launchSubagent({ agent: name, name: "First", task: "work" }, ctx, { piTools: ["edit"] });
      runs.push(first);
      const firstLoadout = readSubagentLoadout(first.sessionFile)!;
      assert.equal(firstLoadout.model, "provider/custom");
      assert.equal(firstLoadout.thinking, "max");
      assert.equal(firstLoadout.toolAllowlist, "launch_custom,subagent,subagent_interrupt,subagent_message,subagents_list,ask_question");
      assert.deepEqual(firstLoadout.spawnable, ["scout"]);
      assert.ok(firstLoadout.toolExtensionPaths!.includes(customExtension));
      const launch = readFileSync(first.launchScriptFile!, "utf8");
      assert.ok(launch.includes(`-e '${customExtension}'`));
      assert.match(launch, /PI_SUBAGENT_ALLOWED='scout'/);
      assert.match(launch, /'\/skill:review' '\/skill:audit'/);
      const snapshot = readFileSync(loadoutSidecarPath(first.sessionFile), "utf8");

      state.update((draft) => { draft.agents[name] = { model: "provider/next", tools: [], skills: [], subagentAgents: [], modelFallback: "inherit" }; });
      runtime.getSubagentsConfigState().replace(loadSubagentsConfig(configPath));
      const second = await runtime.launchSubagent({ agent: name, name: "Second", task: "work" }, ctx, { piTools: ["edit"] });
      runs.push(second);
      assert.equal(readSubagentLoadout(second.sessionFile)!.toolAllowlist, "ask_question");
      assert.equal(readSubagentLoadout(second.sessionFile)!.model, "provider/next");
      assert.deepEqual(readSubagentLoadout(second.sessionFile)!.spawnable, []);
      const secondLaunch = readFileSync(second.launchScriptFile!, "utf8");
      assert.match(secondLaunch, /PI_SUBAGENT_ALLOWED=''/);
      assert.doesNotMatch(secondLaunch, /\/skill:|launch-tool.ts/);
      // Simulate a fresh parent without the original custom tool registration.
      runtime.captureRuntimeToolExtensions({ getAllTools: () => [] } as unknown as ExtensionAPI);
      assert.equal(runtime.getToolExtensionPath("launch_custom", dir), undefined);
      const { parts } = runtime.buildResumeCommandParts(first.sessionFile, readSubagentLoadout(first.sessionFile)!, { artifactDir: dir, name: "First" });
      assert.ok(parts.includes("'provider/custom:max'"));
      assert.ok(parts.includes(`'${firstLoadout.toolAllowlist}'`));
      assert.ok(parts.includes(`'${customExtension}'`));
      assert.ok(!parts.join(" ").includes("provider/next"));
      assert.equal(readFileSync(loadoutSidecarPath(first.sessionFile), "utf8"), snapshot);
      rmSync(customExtension);
      assert.throws(() => runtime.buildResumeCommandParts(first.sessionFile, firstLoadout, { artifactDir: dir, name: "First" }), /recorded source is unavailable/);
      const legacy = { ...firstLoadout };
      delete legacy.toolExtensionPaths;
      assert.throws(() => runtime.buildResumeCommandParts(first.sessionFile, legacy, { artifactDir: dir, name: "First" }), /no reloadable backing extension/);
      assert.equal(readFileSync(loadoutSidecarPath(first.sessionFile), "utf8"), snapshot);

      writeFileSync(join(agentsDir, `${name}.md`), `---\nname: ${name}\n---\nA fixture.\n`);
      runtime.getSubagentsConfigState().replace(DEFAULT_SUBAGENTS_CONFIG);
      const catalog = runtime.getSubagentToolCatalog({ getAllTools: () => [] } as unknown as ExtensionAPI, dir);
      assert.equal(catalog.find((tool) => tool.name === "bash")!.available, true);
      assert.equal(catalog.find((tool) => tool.name === "safe_bash")!.available, true);
      const third = await runtime.launchSubagent({ agent: name, name: "Third", task: "work" }, ctx, { piTools: ["read", "subagent"] });
      runs.push(third);
      assert.equal(readSubagentLoadout(third.sessionFile)!.toolAllowlist, "read,ask_question");

      runtime.getSubagentsConfigState().replace({ ...DEFAULT_SUBAGENTS_CONFIG, agents: {
        [name]: { tools: ["bash", "safe_bash"], subagentAgents: [] },
      } });
      const fourth = await runtime.launchSubagent({ agent: name, name: "Explicit shell toggles", task: "work" }, ctx, { piTools: ["read"] });
      runs.push(fourth);
      const shellLoadout = readSubagentLoadout(fourth.sessionFile)!;
      const safeBashPath = runtime.getToolExtensionPath("safe_bash", dir)!;
      assert.equal(shellLoadout.toolAllowlist, "bash,safe_bash,ask_question");
      assert.deepEqual(shellLoadout.toolExtensionPaths, [safeBashPath]);
      const shellLaunch = readFileSync(fourth.launchScriptFile!, "utf8");
      assert.ok(shellLaunch.includes("--tools 'bash,safe_bash,ask_question'"));
      assert.ok(shellLaunch.includes(`-e '${safeBashPath}'`));
    } finally {
      for (const run of runs) {
        await closeSurface(run.surface);
        runtime.runningSubagents.delete(run.id);
      }
      setSurfaceBackendPreference(oldBackend);
      for (const [key, value] of Object.entries(oldEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }));
});
