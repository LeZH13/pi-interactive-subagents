import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { createSubagentsConfigState, DEFAULT_SUBAGENTS_CONFIG, loadSubagentsConfig, type AgentOverride } from "../pi-extension/subagents/config.ts";
import { showSubagentSettings, type SubagentSettingsDeps } from "../pi-extension/subagents/settings.ts";

const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const CLEAR = "\x15";
const DELETE = "\x1b[3~";

type Defaults = ReturnType<SubagentSettingsDeps["markdownDefaults"]>;

async function withUi(
  run: (ui: {
    component: Component;
    deps: SubagentSettingsDeps;
    input: (...keys: string[]) => void;
    render: (width?: number) => string;
    click: (pattern: RegExp, width?: number) => void;
    focus: (pattern: RegExp, width?: number) => void;
    state: ReturnType<typeof createSubagentsConfigState>;
    saved: () => AgentOverride | undefined;
    configPath: string;
    notifications: Array<{ message: string; type: string }>;
    reopen: () => Promise<void>;
  }) => void | Promise<void>,
  options: { defaults?: Defaults; override?: AgentOverride; agents?: string[] } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-settings-controls-"));
  initTheme("dark", false);
  const configPath = join(dir, "config.json");
  const state = createSubagentsConfigState({
    ...structuredClone(DEFAULT_SUBAGENTS_CONFIG),
    agents: options.override ? { worker: options.override } : {},
  }, configPath);
  const theme = { fg: (_name: string, text: string) => text, bold: (text: string) => text };
  let component!: Component;
  let finish!: () => void;
  const notifications: Array<{ message: string; type: string }> = [];
  const context = {
    hasUI: true,
    ui: {
      theme, notify(message: string, type: string) { notifications.push({ message, type }); },
      custom(factory: any) {
        return new Promise<void>((resolve) => {
          finish = resolve;
          component = factory({ requestRender() {} }, theme, {}, resolve);
        });
      },
    },
  } as any;
  const deps: SubagentSettingsDeps = {
    discoverAgents: () => (options.agents ?? ["worker", "scout"]).map((name) => ({
      name, ...(name === "scout" ? { description: "Read-only exploration" } : {}),
    })),
    markdownDefaults: () => options.defaults ?? {
      model: "test/a", thinking: "medium", tools: ["read"], skills: ["review"],
      subagentAgents: ["scout"], modelFallback: "inherit",
    },
    toolCatalog: () => [
      { name: "read", description: "Read files" }, { name: "write" },
      { name: "inline", available: false },
      ...["ask_question", "subagent", "subagent_interrupt", "subagent_message", "subagents_list"].map((name) => ({ name })),
    ],
    parentActiveTools: () => ["read", "write", "ask_question", "subagent"],
    skillCatalog: () => [{ name: "review", description: "Review startup prompt" }, { name: "design" }],
    registryModels: (preferred) => [...new Set([...(preferred ? [preferred] : []), "test/a", "test/b"])],
    modelSupportsReasoning: () => true,
    configState: state,
    setBackendPreference() {}, setStatusEnabled() {},
    sessionDirs: () => null, runningSessionFiles: () => [], artifactDirFor: () => dir,
  };
  let showing = showSubagentSettings(context, deps);
  const render = (width = 110) => component.render(width).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
  const input = (...keys: string[]) => { for (const key of keys) component.handleInput!(key); };
  const mouseRow = (pattern: RegExp, width = 110, type: "click" | "press" = "click") => {
    const lines = render(width).split("\n");
    const y = lines.findIndex((line) => pattern.test(line));
    assert.notEqual(y, -1, `Missing row ${pattern}:\n${lines.join("\n")}`);
    const event: TuiMouseEvent = {
      type, button: "left", x: 3, y, screenX: 3, screenY: y,
      width, height: lines.length, shift: false, alt: false, ctrl: false,
    };
    assert.equal(component.handleMouse!(event)?.handled, true);
  };
  try {
    input(ENTER); // Open worker's compact grouped detail page.
    await run({
      component, deps, input, render,
      click: (pattern, width) => mouseRow(pattern, width),
      focus: (pattern, width) => mouseRow(pattern, width, "press"),
      state, configPath, notifications,
      reopen: async () => {
        finish();
        await showing;
        state.replace(loadSubagentsConfig(configPath));
        showing = showSubagentSettings(context, deps);
      },
      saved: () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).agents.worker : undefined,
    });
  } finally {
    finish();
    await showing;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("per-agent settings loadout controls", () => {
  it("marks any saved field, including empty lists, disabled fallback, and definition-equal values", async () => {
    await withUi(({ input, render, state, configPath }) => {
      input(ESC);
      assert.match(render(), /\* Saved overrides/);
      for (const override of [{}, { model: undefined }]) {
        state.replace({ ...state.get(), agents: { worker: override } });
        assert.doesNotMatch(render(), /worker\*/);
      }
      for (const override of [
        { model: "test/a" }, { thinking: "medium" }, { tools: [] }, { skills: [] },
        { subagentAgents: [] }, { modelFallback: null }, { modelFallback: "inherit" },
      ]) {
        state.replace({ ...state.get(), agents: { worker: override } });
        assert.match(render(), /worker\*\s+/);
        assert.doesNotMatch(render(), /scout\*/);
      }
      state.replace({ ...state.get(), agents: {} });
      assert.doesNotMatch(render(), /worker\*/);
      assert.equal(existsSync(configPath), false);
    });
  });

  it("updates markers after subset, last-field and all-field reset, and retains them across reopen", async () => {
    await withUi(async ({ input, click, focus, render, state, saved, reopen }) => {
      input(ESC);
      assert.match(render(), /worker\*/);
      input(ENTER);
      click(/Tools\s+No optional tools/);
      click(/Reset field to agent defaults/);
      assert.deepEqual(saved(), { modelFallback: null });
      input(ESC);
      assert.match(render(), /worker\*/);
      input(ENTER);
      focus(/Model fallback\s+Disabled/);
      input(DELETE, ESC);
      assert.equal(state.get().agents.worker, undefined);
      assert.doesNotMatch(render(), /worker\*/);
      input(ENTER, ENTER); // Persist a primary-model override equal to its definition.
      input("test/a$", ENTER, ESC);
      assert.deepEqual(saved(), { model: "test/a" });
      assert.match(render(), /worker\*/);
      await reopen();
      assert.match(render(), /worker\*/);
      input(ENTER);
      click(/Reset to agent defaults/);
      input(ESC);
      assert.doesNotMatch(render(), /worker\*/);
    }, { override: { tools: [], modelFallback: null } });
  });

  it("keeps marked names out of raw search, breadcrumbs, picker entries and config keys", async () => {
    await withUi(({ input, click, render, state, saved }) => {
      input(ESC, "*");
      assert.match(render(), /No matching agents/);
      input(CLEAR, "worker");
      assert.match(render(), /worker\*/);
      assert.match(render(), /1 of 2 agents/);
      input(ENTER);
      assert.match(render(), /Agents › worker\n/);
      assert.doesNotMatch(render(), /worker\*/);
      click(/Tools\s+No optional tools/);
      input("write", " ");
      assert.deepEqual(saved()?.tools, ["write"]);
      assert.deepEqual(Object.keys(state.get().agents), ["worker"]);
      input(ESC);
      click(/Spawnable agents\s+scout/);
      assert.match(render(), /\[ \] worker/);
      assert.doesNotMatch(render(), /worker\*/);
      input(ESC, ESC);
      assert.match(render(), /worker\*/);
    }, { override: { tools: [] } });
  });

  it("shows the saved-override legend only in the root Agents panel", async () => {
    await withUi(({ input, click, render }) => {
      assert.doesNotMatch(render(), /\* Saved overrides/);
      input(ENTER); // Model picker.
      assert.doesNotMatch(render(), /\* Saved overrides/);
      input(ESC);
      click(/Tools\s+read/);
      assert.doesNotMatch(render(), /\* Saved overrides/);
      input(ESC, ESC);
      assert.match(render(), /\* Saved overrides/);
      input("\t");
      assert.doesNotMatch(render(), /\* Saved overrides/);
      input(ENTER); // Launch-surface picker.
      assert.doesNotMatch(render(), /\* Saved overrides/);
    });
  });

  it("retains long-name markers and aligns columns through filtering and narrow rendering", async () => {
    const longName = "研究助手-with-a-very-long-name";
    await withUi(({ input, render, state, component }) => {
      state.replace({ ...state.get(), agents: { worker: { tools: [] }, [longName]: { modelFallback: null } } });
      input(ESC);
      for (const width of [18, 40, 80, 110]) {
        const lines = render(width).split("\n");
        const rows = lines.slice(7, 10);
        assert.match(rows[0], /\*/);
        assert.match(rows[1], /\*/);
        assert.doesNotMatch(rows[2], /\*/);
        for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, line);
        if (width >= 40) {
          const columns = rows.map((row) => {
            const match = /\s{4,}(a)\s{4,}medium$/.exec(row)!;
            return visibleWidth(row.slice(0, match.index + match[0].indexOf("a")));
          });
          assert.equal(new Set(columns).size, 1);
          const thinkingColumns = rows.map((row) => visibleWidth(row.slice(0, row.lastIndexOf("medium"))));
          assert.equal(new Set(thinkingColumns).size, 1);
          input("worker");
          const filtered = render(width).split("\n")[7];
          assert.equal(visibleWidth(filtered.slice(0, filtered.lastIndexOf("medium"))), thinkingColumns[0]);
          input(CLEAR);
        }
      }
    }, { agents: ["worker", longName, "scout"] });
  });

  it("groups compact aligned rows, puts reset last, and shows only focused provenance", async () => {
    await withUi(({ render, focus, configPath }) => {
      const lines = render().split("\n");
      const detail = lines.slice(4, 13);
      assert.deepEqual(detail.map((line) => line.trim().replace(/^→ /, "").split(/\s{4,}/)[0]), [
        "Model", "Thinking", "Model fallback", "", "Tools", "Spawnable agents", "Skills", "", "Reset to agent defaults",
      ]);
      const fieldRows = detail.filter((line) => line.trim() && !line.includes("Reset"));
      const valueColumns = fieldRows.map((line) => {
        const match = /(?:Model fallback|Spawnable agents|Thinking|Model|Tools|Skills)\s{4,}(\S)/.exec(line)!;
        return visibleWidth(line.slice(0, match.index + match[0].length - match[1].length));
      });
      assert.equal(new Set(valueColumns).size, 1);
      assert.equal(valueColumns[0], 2 + 2 + "Spawnable agents".length + 4);
      assert.equal((render().match(/Source:/g) ?? []).length, 1);
      assert.match(render(), /Value: test\/a/);
      focus(/Tools\s+read/);
      assert.match(render(), /Value: 1 optional tool\./);
      assert.doesNotMatch(render(), /Value: test\/a/);
      assert.match(render(), /Enter Edit.*Delete Reset.*Esc Back/);
      focus(/Reset to agent defaults/);
      assert.match(render(), /Already using agent defaults/);
      assert.equal(existsSync(configPath), false);
    });
  });

  it("summarizes large lists and abbreviates model rows without growing the shared help", async () => {
    const longModel = "provider/" + "deep-model-".repeat(8);
    const members = Array.from({ length: 60 }, (_, index) => `secret-member-${index}`);
    await withUi(({ render, focus, component }) => {
      const modelRow = render().split("\n")[4];
      assert.ok(!modelRow.includes(longModel));
      assert.match(render(), new RegExp(`Value: ${longModel}`));
      assert.match(render(), /Tools\s+60 tools/);
      assert.match(render(), /Spawnable agents\s+60 agents/);
      assert.match(render(), /Skills\s+60 skills/);
      assert.doesNotMatch(render(), /secret-member-/);
      const heights = new Map([18, 40, 110].map((width) => [width, component.render(width).length]));
      for (const field of ["Thinking", "Model fallback", "Tools", "Spawnable agents", "Skills", "Reset to agent defaults"]) {
        focus(new RegExp(`^\\s+(?:→ )?${field}(?:\\s|$)`, "m"));
        for (const width of heights.keys()) {
          assert.equal(component.render(width).length, heights.get(width));
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
        }
        assert.doesNotMatch(render(), /secret-member-/);
      }
      focus(/Tools\s+60 tools/);
      assert.match(render(), /Source: Custom override/);
      assert.match(render(), /Value: 60 optional tools/);
    }, { override: { model: longModel, tools: members, skills: members, subagentAgents: members } });
  });

  it("does not select or edit blank group gaps or shared help through mouse input", async () => {
    await withUi(({ component, render, configPath }) => {
      render();
      for (const y of [7, 11, 13, 14, 15, 16, 17, 18]) {
        const event: TuiMouseEvent = {
          type: "click", button: "left", x: 3, y, screenX: 3, screenY: y,
          width: 110, height: 40, shift: false, alt: false, ctrl: false,
        };
        assert.equal(component.handleMouse!(event), undefined);
        assert.match(render(), /→ Model\s+test\/a/);
        assert.match(render(), /Agents › worker\n/);
      }
      assert.equal(existsSync(configPath), false);
    });
  });

  it("summarizes profile defaults and explicit empty/disabled overrides without saving", async () => {
    await withUi(({ render, focus, state, configPath }) => {
      assert.match(render(), /Tools\s+read/);
      assert.match(render(), /Spawnable agents\s+scout/);
      assert.match(render(), /Skills\s+review/);
      assert.match(render(), /Model fallback\s+Inherit parent model/);
      focus(/Skills\s+review/);
      assert.match(render(), /Source: Agent default/);
      assert.match(render(), /Startup skill prompts, not a skill-access allowlist/);
      state.replace({ ...state.get(), agents: { worker: { tools: [], skills: [], subagentAgents: [], modelFallback: null } } });
      assert.match(render(), /Tools\s+No optional tools/);
      assert.match(render(), /Skills\s+No startup skill prompts/);
      assert.match(render(), /Spawnable agents\s+Spawning disabled/);
      assert.match(render(), /Model fallback\s+Disabled/);
      assert.match(render(), /Source: Custom override/);
      assert.equal(existsSync(configPath), false);
    });
  });

  it("seeds unspecified Tools from parent active tools and hides managed checkboxes", async () => {
    await withUi(({ click, focus, render, configPath }) => {
      focus(/Tools\s+Parent's active tools/);
      assert.match(render(), /Source: Parent default/);
      click(/Tools\s+Parent's active tools/);
      assert.match(render(), /\[x\] read/);
      assert.match(render(), /\[x\] write/);
      assert.doesNotMatch(render(), /\[[ x]\] (?:ask_question|subagent(?:_interrupt|_message|s_list)?)/);
      assert.match(render(), /ask_question is always included/);
      assert.match(render(), /spawning tools are managed by Spawnable agents/);
      assert.equal(existsSync(configPath), false);
    }, { defaults: { model: "test/a" } });
  });

  it("persists Space and Enter toggles across searches immediately and Escape keeps them", async () => {
    await withUi(({ input, click, render, state, saved }) => {
      click(/Tools\s+read/);
      input("write", " ");
      assert.match(render(), /\[x\] write/);
      assert.deepEqual(saved()?.tools, ["read", "write"]);
      assert.match(render(), /Agents › worker › Tools/);
      assert.match(render(), /↑↓ Move · Enter\/Space Toggle · Esc Back/);
      assert.doesNotMatch(render(), /Apply|draft|Cancel|Clear all/);
      input(CLEAR, "read", ENTER);
      assert.match(render(), /\[ \] read/);
      assert.deepEqual(state.get().agents.worker.tools, ["write"]);
      assert.deepEqual(saved()?.tools, ["write"]);
      input(ESC);
      assert.match(render(), /Agents › worker\n/);
      assert.match(render(), /Tools\s+write/);
      click(/Tools\s+write/);
      assert.match(render(), /\[ \] read/);
      assert.match(render(), /\[x\] write/);
    });
  });

  it("mouse clicks save each checklist immediately, remain open, and Escape retains changes", async () => {
    for (const [label, field, member] of [
      ["Tools", "tools", "read"], ["Spawnable agents", "subagentAgents", "scout"], ["Skills", "skills", "review"],
    ] as const) {
      await withUi(({ click, input, render, state, saved }) => {
        click(new RegExp(`${label}\\s+${member}`));
        click(new RegExp(`\\[x\\] ${member}`));
        assert.deepEqual(saved()?.[field], []);
        assert.deepEqual(state.get().agents.worker[field], []);
        assert.match(render(), new RegExp(`Agents › worker › ${label}`));
        click(new RegExp(`\\[ \\] ${member}`));
        assert.deepEqual(saved()?.[field], [member]);
        assert.match(render(), new RegExp(`Agents › worker › ${label}`));
        input(ESC);
        assert.deepEqual(saved()?.[field], [member]);
        assert.match(render(), /Agents › worker\n/);
        assert.match(render(), /Source: Custom override/);
      });
    }
  });

  it("failed writes leave the last saved checkbox state visible and notify without leaving the picker", async () => {
    await withUi(({ click, input, render, state, saved, notifications }) => {
      click(/Tools\s+read/);
      input("write", " ");
      assert.deepEqual(saved()?.tools, ["read", "write"]);
      const update = state.update;
      state.update = () => { throw new Error("Disk full"); };
      input(CLEAR, "read", " ");
      assert.deepEqual(state.get().agents.worker.tools, ["read", "write"]);
      assert.deepEqual(saved()?.tools, ["read", "write"]);
      assert.match(render(), /\[x\] read/);
      assert.match(render(), /Agents › worker › Tools/);
      assert.deepEqual(notifications, [{ message: "Could not save Tools: Disk full", type: "error" }]);
      click(/Reset field to agent defaults/);
      assert.match(render(), /Agents › worker › Tools/);
      assert.deepEqual(saved()?.tools, ["read", "write"]);
      assert.equal(notifications.length, 2);
      state.update = update;
      input(CLEAR, "read", ENTER);
      assert.deepEqual(saved()?.tools, ["write"]);
      assert.match(render(), /\[ \] read/);
    });
  });

  it("a live toggle persists only the current field and an explicit empty tools list", async () => {
    const override = { thinking: "high", skills: ["review"], subagentAgents: ["scout"], modelFallback: null };
    await withUi(({ click, input, render, state, saved }) => {
      click(/Tools\s+read/);
      input(" "); // Uncheck the only inherited optional tool.
      assert.match(render(), /Agents › worker › Tools/);
      assert.deepEqual(state.get().agents.worker, { ...override, tools: [] });
      assert.deepEqual(saved(), { ...override, tools: [] });
      input(ESC);
      assert.match(render(), /No optional tools/);
    }, { override });
  });

  it("retains selected missing/non-reloadable tools and permits removal, not adding unavailable tools", async () => {
    await withUi(({ click, input, render, saved }) => {
      click(/Tools\s+missing, inline/);
      assert.match(render(), /\[x\] missing \(unavailable\)/);
      assert.match(render(), /\[x\] inline \(unavailable\)/);
      input("write", ENTER); // Saving another toggle retains the unavailable selections.
      assert.deepEqual(saved()?.tools, ["missing", "inline", "write"]);
      input(ENTER, CLEAR, "inline", " ", " "); // Remove; unavailable tools cannot be added back.
      assert.match(render(), /\[ \] inline \(unavailable\)/);
      assert.deepEqual(saved()?.tools, ["missing"]);
      input(ESC);
      click(/Tools\s+missing/);
      input("inline", ENTER);
      assert.match(render(), /\[ \] inline \(unavailable\)/);
      input(ESC);
      assert.deepEqual(saved()?.tools, ["missing"]);
    }, { override: { tools: ["missing", "inline"] } });
  });

  it("uses discovered spawnable agents, retains missing entries, and supports disabling spawning", async () => {
    await withUi(({ click, input, render, state, saved }) => {
      click(/Spawnable agents\s+retired/);
      assert.match(render(), /\[x\] retired \(unavailable\)/);
      assert.match(render(), /\[ \] scout/);
      input("scout", ENTER);
      assert.deepEqual(saved()?.subagentAgents, ["retired", "scout"]);
      assert.match(render(), /Agents › worker › Spawnable agents/);
      input(CLEAR, "retired", " ", CLEAR, "scout", " ");
      assert.deepEqual(state.get().agents.worker.subagentAgents, []);
      assert.deepEqual(saved()?.subagentAgents, []);
      input(ESC);
      assert.match(render(), /Spawning disabled/);
    }, { override: { subagentAgents: ["retired"] } });
  });

  it("treats Skills as startup prompts and retains unavailable selections", async () => {
    await withUi(({ click, input, render, saved }) => {
      click(/Skills\s+obsolete/);
      assert.match(render(), /\[x\] obsolete \(unavailable\)/);
      assert.match(render(), /not a skill-access allowlist/);
      input("design", " ");
      assert.deepEqual(saved()?.skills, ["obsolete", "design"]);
      assert.match(render(), /Agents › worker › Skills/);
      input(CLEAR, "obsolete", " ", CLEAR, "design", " ");
      assert.deepEqual(saved()?.skills, []);
      input(ESC);
      assert.match(render(), /Skills\s+No startup skill prompts/);
    }, { override: { skills: ["obsolete"] } });
  });

  it("resets just one field and restores profile defaults without losing other overrides", async () => {
    const override = { model: "test/b", thinking: "high", tools: [], skills: [], subagentAgents: [], modelFallback: null };
    await withUi(({ click, render, state, saved }) => {
      click(/Skills\s+No startup skill prompts/);
      click(/Reset field to agent defaults/);
      const { skills: _skills, ...expected } = override;
      assert.deepEqual(state.get().agents.worker, expected);
      assert.deepEqual(saved(), expected);
      assert.match(render(), /Skills\s+review/);
      assert.match(render(), /Source: Agent default/);
    }, { override });
  });

  it("Delete resets any selected field, including locked Thinking, and reset-all is last", async () => {
    const override = { model: "test/b", thinking: "high", tools: [], skills: [], subagentAgents: [], modelFallback: null };
    await withUi(({ input, render, deps, state, saved }) => {
      deps.modelSupportsReasoning = () => false;
      input(DOWN, DELETE); // Thinking is locked, but its stale override is still resettable.
      assert.equal(state.get().agents.worker.thinking, undefined);
      assert.equal(state.get().agents.worker.model, "test/b");
      input(DOWN, DOWN, DOWN, DOWN, DOWN, ENTER); // Last row: reset all.
      assert.equal(state.get().agents.worker, undefined);
      assert.equal(saved(), undefined);
      assert.match(render(), /Already using agent defaults/);
    }, { override });
  });

  it("offers regex-filtered explicit fallback models, inherit, disabled=null, and field reset", async () => {
    await withUi(({ click, input, render, state, saved }) => {
      click(/Model fallback\s+Inherit parent model/);
      assert.match(render(), /Search models \(regex\)/);
      input("test/b$", ENTER);
      assert.equal(saved()?.modelFallback, "test/b");
      click(/Model fallback\s+test\/b/);
      input("[", ENTER);
      assert.match(render(), /Invalid regex/);
      assert.equal(state.get().agents.worker.modelFallback, "test/b");
      input(CLEAR, "inherit", ENTER);
      assert.equal(saved()?.modelFallback, "inherit");
      click(/Model fallback\s+Inherit parent model/);
      input("disabled", ENTER);
      assert.equal(saved()?.modelFallback, null);
      assert.match(render(), /Model fallback\s+Disabled/);
      assert.match(render(), /Source: Custom override/);
      click(/Model fallback\s+Disabled/);
      input("reset", ENTER);
      assert.equal(saved(), undefined);
      assert.match(render(), /Model fallback\s+Inherit parent model/);
      assert.match(render(), /Source: Agent default/);
    });
  });

  it("displays retained fallback entries even when absent from the registry", async () => {
    await withUi(({ deps, click, render, input, configPath }) => {
      deps.registryModels = () => ["test/a"];
      click(/Model fallback\s+missing\/fallback/);
      assert.match(render(), /missing\/fallback \(unavailable\)/);
      input(ESC);
      assert.equal(existsSync(configPath), false);
    }, { override: { modelFallback: "missing/fallback" } });
  });

  it("preserves hidden agents' durable overrides through every settings mutation", async () => {
    await withUi(({ state, click, input, saved, configPath }) => {
      const hidden = { model: "other/model", tools: [], skills: ["hidden-skill"], subagentAgents: [], modelFallback: null };
      state.replace({ ...state.get(), agents: { worker: { skills: [] }, hidden } });
      const check = () => {
        assert.deepEqual(state.get().agents.hidden, hidden);
        assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")).agents.hidden, hidden);
      };
      click(/Model\s+test\/a/);
      input("test/b$", ENTER); // Single-value field save.
      assert.equal(saved()?.model, "test/b");
      check();
      click(/Tools\s+read/);
      input(" "); // List toggle saves without pruning hidden agents.
      assert.deepEqual(saved()?.tools, []);
      check();
      click(/Reset field to agent defaults/); // Field reset.
      assert.equal(saved()?.tools, undefined);
      check();
      click(/Reset to agent defaults/); // Reset all for the visible agent only.
      assert.equal(saved(), undefined);
      check();
    });
  });

  it("marks Pi-only controls unsupported for cli:claude and leaves their saved overrides untouched", async () => {
    const override = { tools: [], skills: [], subagentAgents: [], modelFallback: null };
    await withUi(({ input, render, state, configPath }) => {
      assert.match(render(), /Tools\s+Unsupported for cli:claude/);
      assert.match(render(), /Spawnable agents\s+Unsupported for cli:claude/);
      assert.match(render(), /Skills\s+Unsupported for cli:claude/);
      assert.match(render(), /Model fallback\s+Unsupported for cli:claude/);
      input(DOWN, DOWN); // Model fallback, then the three Pi-only loadout fields.
      for (let i = 0; i < 4; i++) {
        input(ENTER, DELETE);
        assert.match(render(), /Agents › worker\n/);
        input(DOWN);
      }
      assert.deepEqual(state.get().agents.worker, override);
      assert.equal(existsSync(configPath), false);
    }, { defaults: { cli: "claude", model: "anthropic/claude-sonnet" }, override });
  });

  it("does not mistake an Anthropic Pi model for a Claude CLI profile", async () => {
    await withUi(({ click, render }) => {
      assert.doesNotMatch(render(), /Unsupported/);
      click(/Tools\s+Parent's active tools/);
      assert.match(render(), /Agents › worker › Tools/);
    }, { defaults: { model: "anthropic/claude-sonnet" } });
  });

  it("shows no-match recovery and field reset without adding commit or clear-all actions", async () => {
    await withUi(({ deps, click, input, render, configPath }) => {
      deps.skillCatalog = () => [];
      click(/Skills\s+No startup skill prompts/);
      input("no-match");
      assert.match(render(), /No matching choices/);
      assert.match(render(), /Reset field to agent defaults/);
      assert.doesNotMatch(render(), /Apply|draft|Cancel|Clear all/);
      input(ESC);
      assert.equal(existsSync(configPath), false);
    }, { defaults: {} });
  });

  it("propagates search focus and bounds every checkbox/model line at narrow widths", async () => {
    await withUi(({ component, click, input }) => {
      const focused = component as Component & { focused: boolean };
      const check = () => {
        for (const width of [1, 4, 18, 40, 80, 110]) {
          for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, line);
          component.invalidate();
        }
      };
      check();
      for (const label of ["Tools", "Spawnable agents", "Skills", "Model fallback"]) {
        click(new RegExp(`${label}\\s+`));
        focused.focused = true;
        assert.ok(component.render(80).join("\n").includes(CURSOR_MARKER));
        check();
        focused.focused = false;
        assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
        input(ESC);
      }
    });
  });
});
