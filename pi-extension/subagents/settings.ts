/**
 * `/subagent-settings` overlay: backend preference, status-widget toggle, one
 * grouped row per discovered agent (model + thinking + reset), and an orphan
 * cleanup row. Built on pi-tui SettingsList, mirroring pi's /settings page.
 *
 * Every change applies live in memory and persists to config.json immediately
 * (atomic write). Empty per-agent overrides are dropped; overrides for agents
 * that no longer exist are pruned on each save.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSelectListTheme, getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import {
  Container,
  Input,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  truncateToWidth,
  type Component,
  type SelectItem,
  type SettingItem,
} from "@mariozechner/pi-tui";
import { basename } from "node:path";
import {
  cleanOrphanArtifactDirs,
  findOrphanArtifactDirs,
} from "./session.ts";
import type { SubagentsConfigState } from "./config.ts";
import { getSurfaceBackendPreference, isHerdrAvailable, isTmuxAvailable, resolveSurfaceBackend } from "./surface.ts";

export interface SubagentSettingsDeps {
  /** Live agent discovery (project > global > bundled, allowlist-filtered). */
  discoverAgents: () => Array<{ name: string; description?: string }>;
  /** Markdown (.md) defaults for one agent, bare model id + thinking. */
  markdownDefaults: (agentName: string) => { model?: string; thinking?: string };
  /** Live registry models as `provider/id` strings, preferred first. */
  registryModels: (preferred?: string) => string[];
  /** Whether a model id supports reasoning (false → thinking locked to off). */
  modelSupportsReasoning: (model: string | undefined) => boolean;
  /** Current config state (live + persisted). */
  configState: SubagentsConfigState;
  /** Called after backend changes so the live preference takes effect. */
  setBackendPreference: (backend: "auto" | "tmux" | "herdr" | "background") => void;
  /** Called after the status toggle so widget rendering follows. */
  setStatusEnabled: (enabled: boolean) => void;
  /** Resolve artifact dirs for the current session (orphan row). */
  sessionDirs: (ctx: ExtensionContext) => { sessionDir: string; sessionId: string } | null;
  runningSessionFiles: () => string[];
  artifactDirFor: (sessionDir: string, sessionId: string) => string;
}

const STANDARD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function uniquePreferred(values: Array<string | undefined>, all: string[]): string[] {
  const result: string[] = [];
  for (const value of [...values, ...all]) {
    const trimmed = value?.trim();
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

export function regexFilterModels(models: string[], pattern: string): {
  matches: string[];
  error?: string;
} {
  if (!pattern) return { matches: [...models] };
  try {
    const regex = new RegExp(pattern, "i");
    return { matches: models.filter((model) => regex.test(model)) };
  } catch (error) {
    return {
      matches: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function thinkingLevelsForModel(supportsReasoning: boolean, preferred?: string): string[] {
  if (!supportsReasoning) return ["off"];
  return uniquePreferred([preferred], [...STANDARD_THINKING_LEVELS]);
}

/** Type-to-filter model list used inside the settings overlay. */
function modelFilterComponent(
  ctx: ExtensionContext,
  models: string[],
  initial: string | undefined,
  done: (selectedValue?: string) => void,
): Component {
  let selectList: SelectList;
  let pattern = "";
  let regexError: string | undefined;
  const input = new Input();
  if (initial) input.setValue("");

  const rebuild = () => {
    const filtered = regexFilterModels(models, pattern);
    regexError = filtered.error;
    const items: SelectItem[] = filtered.matches.map((model) => ({ value: model, label: model }));
    const next = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
    if (initial) {
      const idx = filtered.matches.indexOf(initial);
      if (idx !== -1) next.setSelectedIndex(idx);
    }
    next.onSelect = (item) => done(item.value);
    next.onCancel = () => done();
    selectList = next;
  };
  rebuild();

  return {
    invalidate() {
      input.invalidate();
      selectList.invalidate();
    },
    render(width: number) {
      const theme = ctx.ui.theme;
      const lines = [
        truncateToWidth(theme.fg("accent", theme.bold("Select model")), width),
        ...input.render(width),
      ];
      if (regexError) lines.push(truncateToWidth(theme.fg("error", `Invalid regex: ${regexError}`), width));
      lines.push(...selectList.render(width));
      lines.push(truncateToWidth(theme.fg("dim", "type regex • ↑↓ navigate • enter select • esc back"), width));
      return lines.map((line) => truncateToWidth(line, width));
    },
    handleInput(data: string) {
      const keybindings = (ctx as unknown as { keybindings?: { matches(d: string, id: string): boolean } }).keybindings;
      const cancel = keybindings
        ? keybindings.matches(data, "tui.select.cancel")
        : data === "\x1b" || data === "\x03";
      if (cancel) {
        done();
        return;
      }
      const nav = keybindings
        ? keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm")
        : data === "\x1b[A" || data === "\x1b[B" || data === "\r";
      if (nav) {
        selectList.handleInput(data);
        return;
      }
      const before = input.getValue();
      input.handleInput(data);
      const after = input.getValue();
      if (after !== before) {
        pattern = after;
        rebuild();
      }
    },
  } as Component;
}

function simpleSelectComponent(
  ctx: ExtensionContext,
  title: string,
  options: string[],
  currentValue: string,
  done: (selectedValue?: string) => void,
): Component {
  const items: SelectItem[] = options.map((value) => ({ value, label: value }));
  const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
  const idx = options.indexOf(currentValue);
  if (idx !== -1) list.setSelectedIndex(idx);
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done();
  const theme = ctx.ui.theme;
  return {
    invalidate() {
      list.invalidate();
    },
    render(width: number) {
      return [
        truncateToWidth(theme.fg("accent", theme.bold(title)), width),
        ...list.render(width),
        truncateToWidth(theme.fg("dim", "enter select • esc back"), width),
      ];
    },
    handleInput(data: string) {
      list.handleInput(data);
    },
  } as Component;
}

function describeOverride(
  overrideModel: string | undefined,
  overrideThinking: string | undefined,
  markdownModel: string | undefined,
  markdownThinking: string | undefined,
): string {
  if (overrideModel || overrideThinking) {
    const parts: string[] = [];
    if (overrideModel) parts.push(overrideModel);
    if (overrideThinking) parts.push(overrideThinking);
    return `${parts.join(" · ")} (override)`;
  }
  const parts: string[] = [];
  if (markdownModel) parts.push(markdownModel);
  if (markdownThinking) parts.push(markdownThinking);
  return parts.length > 0 ? `${parts.join(" · ")} (markdown)` : "markdown default";
}

function orphanSummary(sessionDir: string, currentSessionId: string, runningFiles: string[]): string {
  try {
    const candidates = findOrphanArtifactDirs(sessionDir, {
      dryRun: true,
      currentSessionId,
      runningSessionFiles: runningFiles,
      minAgeMs: 0,
    });
    if (candidates.length === 0) return "no orphans";
    const files = candidates.reduce((sum, c) => sum + c.fileCount, 0);
    const kb = Math.round(candidates.reduce((sum, c) => sum + c.sizeBytes, 0) / 1024);
    return `${candidates.length} orphan${candidates.length === 1 ? "" : "s"} · ${files} files · ${kb} KB`;
  } catch {
    return "unavailable";
  }
}

function orphanDetailComponent(
  ctx: ExtensionContext,
  deps: SubagentSettingsDeps,
  done: (selectedValue?: string) => void,
  onChanged: () => void,
): Component {
  const theme = ctx.ui.theme;
  let candidates: Array<{ dir: string; fileCount: number; sizeBytes: number }> = [];
  let error: string | null = null;
  const dirs = deps.sessionDirs(ctx);
  if (dirs) {
    try {
      candidates = findOrphanArtifactDirs(dirs.sessionDir, {
        dryRun: true,
        currentSessionId: dirs.sessionId,
        runningSessionFiles: deps.runningSessionFiles(),
        minAgeMs: 0,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    error = "No session file — open a persistent session to inspect orphans.";
  }

  const items: SelectItem[] = candidates.length === 0
    ? [{ value: "__none", label: "No orphan artifacts found" }]
    : candidates.map((c) => ({
      value: c.dir,
      label: `${basename(c.dir)} · ${c.fileCount} files · ${Math.round(c.sizeBytes / 1024)} KB`,
    }));
  const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), getSelectListTheme());
  list.onSelect = async (item) => {
    if (item.value === "__none" || !dirs) {
      done();
      return;
    }
    const ok = await ctx.ui.confirm(
      "Confirm Orphan Cleanup",
      `Permanently clean recognized extension artifacts in ${basename(item.value)}? ` +
        `Ensure no child from a deleted parent is still running in another Pi process.`,
    );
    if (!ok) {
      done();
      return;
    }
    try {
      cleanOrphanArtifactDirs(dirs.sessionDir, {
        dryRun: false,
        currentSessionId: dirs.sessionId,
        runningSessionFiles: deps.runningSessionFiles(),
        minAgeMs: 0,
      });
      ctx.ui.notify("Orphan cleanup complete.", "info");
    } catch (err) {
      ctx.ui.notify(`Orphan cleanup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    onChanged();
    done("cleaned");
  };
  list.onCancel = () => done();

  return {
    invalidate() {
      list.invalidate();
    },
    render(width: number) {
      const lines = [truncateToWidth(theme.fg("accent", theme.bold("Orphan artifacts")), width)];
      if (error) lines.push(truncateToWidth(theme.fg("warning", error), width));
      lines.push(...list.render(width));
      lines.push(truncateToWidth(theme.fg("dim", "enter preview+confirm delete • esc back"), width));
      return lines;
    },
    handleInput(data: string) {
      list.handleInput(data);
    },
  } as Component;
}

function agentSubmenu(
  ctx: ExtensionContext,
  deps: SubagentSettingsDeps,
  agentName: string,
  onChanged: (summary: string) => void,
): Component {
  const theme = ctx.ui.theme;
  const options = ["Model…", "Thinking…", "Reset to markdown"];
  const list = new SelectList(
    options.map((label) => ({ value: label, label })),
    3,
    getSelectListTheme(),
  );
  let nested: Component | null = null;

  const currentOverride = () => deps.configState.get().agents[agentName] ?? {};
  const currentMarkdown = () => deps.markdownDefaults(agentName);

  const openNested = (kind: "model" | "thinking") => {
    const md = currentMarkdown();
    const override = currentOverride();
    if (kind === "model") {
      const models = deps.registryModels(override.model ?? md.model);
      nested = modelFilterComponent(ctx, models, override.model ?? md.model, (selected) => {        nested = null;
        if (selected !== undefined) {
          deps.configState.update(
            (draft) => {
              draft.agents[agentName] = { ...(draft.agents[agentName] ?? {}), model: selected };
            },
            { pruneAgents: deps.discoverAgents().map((a) => a.name) },
          );
          const after = currentOverride();
          onChanged(describeOverride(after.model, after.thinking, md.model, md.thinking));
        }
      });
    } else {
      const effectiveModel = override.model ?? md.model;
      const levels = thinkingLevelsForModel(
        deps.modelSupportsReasoning(effectiveModel),
        override.thinking ?? md.thinking,
      );
      nested = simpleSelectComponent(
        ctx,
        `Thinking for ${agentName}`,
        levels,
        override.thinking ?? md.thinking ?? levels[0],
        (selected) => {
          nested = null;
          if (selected !== undefined) {
            deps.configState.update(
              (draft) => {
                draft.agents[agentName] = { ...(draft.agents[agentName] ?? {}), thinking: selected };
              },
              { pruneAgents: deps.discoverAgents().map((a) => a.name) },
            );
            const after = currentOverride();
            onChanged(describeOverride(after.model, after.thinking, md.model, md.thinking));
          }
        },
      );
    }
  };

  list.onSelect = (item) => {
    if (item.value === "Model…") openNested("model");
    else if (item.value === "Thinking…") openNested("thinking");
  };
  // Reset is a direct action, not a nested submenu.
  const originalHandleInput = list.handleInput.bind(list);

  return {
    invalidate() {
      nested?.invalidate();
      list.invalidate();
    },
    render(width: number) {
      if (nested) return nested.render(width);
      const md = currentMarkdown();
      const override = currentOverride();
      return [
        truncateToWidth(theme.fg("accent", theme.bold(`Subagent: ${agentName}`)), width),
        truncateToWidth(
          theme.fg("muted", `markdown: ${md.model ?? "—"}${md.thinking ? ` · ${md.thinking}` : ""}`),
          width,
        ),
        ...list.render(width),
        truncateToWidth(theme.fg("dim", "enter open • esc back"), width),
      ];
    },
    handleInput(data: string) {
      if (nested) {
        nested.handleInput(data);
        return;
      }
      const selected = list.getSelectedItem();
      // Intercept confirm on the Reset row so it acts immediately.
      const keybindings = (ctx as unknown as { keybindings?: { matches(d: string, id: string): boolean } }).keybindings;
      const isConfirm = keybindings
        ? keybindings.matches(data, "tui.select.confirm")
        : data === "\r";
      if (isConfirm && selected?.value === "Reset to markdown") {
        deps.configState.update(
          (draft) => {
            delete draft.agents[agentName];
          },
          { pruneAgents: deps.discoverAgents().map((a) => a.name) },
        );
        const md = currentMarkdown();
        onChanged(describeOverride(undefined, undefined, md.model, md.thinking));
        return;
      }
      originalHandleInput(data);
    },
  } as Component;
}

export function buildSubagentSettingItems(
  ctx: ExtensionContext,
  deps: SubagentSettingsDeps,
  onOrphanChanged: () => void,
): SettingItem[] {
  const snapshot = deps.configState.get();
  const agents = deps.discoverAgents();
  const items: SettingItem[] = [];

  let effectiveBackend: string;
  try {
    effectiveBackend = resolveSurfaceBackend();
  } catch (err) {
    effectiveBackend = `error (${err instanceof Error ? err.message : String(err)})`;
  }
  items.push({
    id: "backend",
    label: "Backend",
    description:
      `Surface backend for new subagents (preference: ${getSurfaceBackendPreference()}, ` +
      `effective: ${effectiveBackend}, tmux: ${isTmuxAvailable() ? "yes" : "no"}, ` +
      `Herdr: ${isHerdrAvailable() ? "yes" : "no"}). Persists to config.json and applies live.`,
    currentValue: snapshot.multiplexing.backend,
    submenu: (currentValue, done) => simpleSelectComponent(
      ctx,
      "Subagent backend",
      ["auto", "tmux", "herdr", "background"],
      currentValue,
      (selected) => {
        if (selected !== undefined) {
          const backend = selected as "auto" | "tmux" | "herdr" | "background";
          deps.configState.update((draft) => {
            draft.multiplexing.backend = backend;
          });
          deps.setBackendPreference(backend);
        }
        done(selected);
      },
    ),
  });

  items.push({
    id: "status-widget",
    label: "Status widget",
    description: "Show the live subagent status widget above the editor. Persists to config.json.",
    currentValue: snapshot.status.enabled ? "true" : "false",
    submenu: (currentValue, done) => simpleSelectComponent(
      ctx,
      "Status widget",
      ["true", "false"],
      currentValue,
      (selected) => {
        if (selected !== undefined) {
          const enabled = selected === "true";
          deps.configState.update((draft) => {
            draft.status.enabled = enabled;
          });
          deps.setStatusEnabled(enabled);
        }
        done(selected);
      },
    ),
  });

  for (const agent of agents) {
    const md = deps.markdownDefaults(agent.name);
    const override = snapshot.agents[agent.name];
    items.push({
      id: `agent:${agent.name}`,
      label: agent.name,
      description: agent.description ?? `Model and thinking defaults for the ${agent.name} agent.`,
      currentValue: describeOverride(override?.model, override?.thinking, md.model, md.thinking),
      submenu: (_currentValue, done) => agentSubmenu(ctx, deps, agent.name, (summary) => {
        done(summary);
      }),
    });
  }

  const dirs = deps.sessionDirs(ctx);
  items.push({
    id: "orphan-cleanup",
    label: "Orphan cleanup",
    description: "Preview orphaned subagent artifacts and delete them after confirmation.",
    currentValue: dirs
      ? orphanSummary(dirs.sessionDir, dirs.sessionId, deps.runningSessionFiles())
      : "no session",
    submenu: (_currentValue, done) => orphanDetailComponent(ctx, deps, done, onOrphanChanged),
  });

  return items;
}

export async function showSubagentSettings(
  ctx: ExtensionCommandContext,
  deps: SubagentSettingsDeps,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Subagent settings require interactive mode.", "warning");
    return;
  }
  let settingsList: SettingsList;
  await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new Text(theme.fg("accent", theme.bold("Subagent settings")), 0, 0));
    container.addChild(new Spacer(1));

    const refreshOrphanRow = () => {
      const dirs = deps.sessionDirs(ctx);
      settingsList.updateValue(
        "orphan-cleanup",
        dirs
          ? orphanSummary(dirs.sessionDir, dirs.sessionId, deps.runningSessionFiles())
          : "no session",
      );
    };

    const refreshAllRows = () => {
      const snapshot = deps.configState.get();
      settingsList.updateValue("backend", snapshot.multiplexing.backend);
      settingsList.updateValue(
        "status-widget",
        snapshot.status.enabled ? "true" : "false",
      );
      for (const agent of deps.discoverAgents()) {
        const md = deps.markdownDefaults(agent.name);
        const override = snapshot.agents[agent.name];
        settingsList.updateValue(
          `agent:${agent.name}`,
          describeOverride(override?.model, override?.thinking, md.model, md.thinking),
        );
      }
      refreshOrphanRow();
    };

    const items = buildSubagentSettingItems(ctx, deps, refreshOrphanRow);
    settingsList = new SettingsList(
      items,
      12,
      getSettingsListTheme(),
      (id, _newValue) => {
        // Values are persisted by the submenu/cycle handlers before done()
        // fires; SettingsList already updated the row's currentValue from the
        // done() summary — refresh from state so backend/agent rows show the
        // canonical persisted value.
        void id;
        if (id === "status-widget") {
          const enabled = deps.configState.get().status.enabled;
          deps.setStatusEnabled(enabled);
        }
        refreshAllRows();
      },
      () => done(),
      { enableSearch: true },
    );
    container.addChild(settingsList);
    return container;
  });
}

export function registerSubagentSettingsCommand(
  pi: ExtensionAPI,
  deps: SubagentSettingsDeps,
): void {
  pi.registerCommand("subagent-settings", {
    description: "Open subagent settings: backend, status widget, per-agent model/thinking, orphan cleanup",
    handler: async (_args, ctx) => {
      await showSubagentSettings(ctx, deps);
    },
  });
}
