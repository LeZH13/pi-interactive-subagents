/**
 * Live, immediately persisted subagent settings. Each tab keeps its own search
 * and selection; a navigation stack keeps edits on the agent's detail page.
 * Built-in Input and SelectList components own editing, filtering navigation,
 * scrolling, and mouse selection. Layout and provenance use Pi's active theme.
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  SelectList,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type Keybinding,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { cleanOrphanArtifactDirs, findOrphanArtifactDirs } from "./session.ts";
import type { AgentOverride, SubagentsConfigState } from "./config.ts";
import { isHerdrAvailable, isTmuxAvailable, resolveSurfaceBackend } from "./surface.ts";

export interface SubagentSettingsDeps {
  /** Live agent discovery (project > global > bundled, allowlist-filtered). */
  discoverAgents: () => Array<{ name: string; description?: string }>;
  /** Profile defaults, before persistent overrides; cli identifies unsupported controls. */
  markdownDefaults: (agentName: string) => {
    model?: string; thinking?: string; cli?: string;
    tools?: string[]; skills?: string[]; subagentAgents?: string[]; modelFallback?: string | null;
  };
  /** Discovered choices only. Managed orchestration tools are excluded by the UI. */
  toolCatalog: () => Array<{ name: string; description?: string; available?: boolean }>;
  /** Active parent tools seed selection when the profile has no tools definition. */
  parentActiveTools: () => string[];
  /** Startup skill prompts, not a skill-access allowlist. */
  skillCatalog: () => Array<{ name: string; description?: string; available?: boolean }>;
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
  sessionDirs: (ctx: ExtensionContext) => { sessionDir: string; sessionId: string } | null;
  runningSessionFiles: () => string[];
  artifactDirFor: (sessionDir: string, sessionId: string) => string;
}

const STANDARD_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FIELD_GAP = "    ";

function uniquePreferred(values: Array<string | undefined>, all: string[]): string[] {
  const result: string[] = [];
  for (const value of [...values, ...all]) {
    const trimmed = value?.trim();
    if (trimmed && !result.includes(trimmed)) result.push(trimmed);
  }
  return result;
}

export function regexFilterModels(models: string[], pattern: string): { matches: string[]; error?: string } {
  if (!pattern) return { matches: [...models] };
  try {
    const regex = new RegExp(pattern, "i");
    return { matches: models.filter((model) => regex.test(model)) };
  } catch {
    return { matches: [], error: "Invalid regex. Check brackets or clear the search." };
  }
}

interface SettingsView extends Component, Focusable {
  path: string[];
  action: string;
  readonly hasSearchQuery: boolean;
  confirmLabel?: string;
  hints?: string[];
}

/** Shared selection shell; all keyboard navigation and scrolling stay in SelectList. */
function selectionView(
  ctx: ExtensionContext,
  options: {
    path: string[];
    items: SelectItem[];
    initial?: string;
    action?: string;
    search?: "agents" | "models" | "tools" | "skills";
    pinnedItems?: SelectItem[];
    spaceSelect?: boolean;
    empty: string;
    legend?: string;
    formatItems?: (items: SelectItem[], width: number) => void;
    detail?: (item: SelectItem) => string;
    onSelect: (item: SelectItem) => void;
    onBack: () => void;
  },
): SettingsView {
  const input = new Input({
    prompt: "",
    placeholder: options.search === "models" ? "provider/model or regex" : `Type ${options.search === "agents" ? "an agent" : "a " + options.search?.slice(0, -1)} name`,
    placeholderStyle: (text) => ctx.ui.theme.fg("dim", text),
  });
  let list: SelectList;
  let error: string | undefined;
  let matchingCount = options.items.length;
  // Keep the originals for fuzzy search: display labels can change with width or config.
  const originals = options.items.map((item) => ({ ...item }));
  let displayed: SelectItem[] = [];
  const rebuild = () => {
    const previous = list?.getSelectedItem()?.value ?? options.initial;
    const query = input.getValue();
    error = undefined;
    if (options.search === "models") {
      const filtered = regexFilterModels(originals.map((item) => item.value), query);
      error = filtered.error;
      const matches = new Set(filtered.matches);
      displayed = originals.filter((item) => matches.has(item.value)).map((item) => ({ ...item }));
    } else {
      displayed = fuzzyFilter(originals, query, (item) => item.value).map((item) => ({ ...item }));
    }
    matchingCount = displayed.length;
    const firstMatch = displayed[0]?.value;
    displayed = [...(options.pinnedItems ?? []).map((item) => ({ ...item })), ...displayed];
    list = new SelectList(displayed, 10, {
      ...getSelectListTheme(),
      noMatch: () => ctx.ui.theme.fg("muted", options.empty),
    }, { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth) });
    const previousIndex = displayed.findIndex((item) => item.value === previous);
    const previousIsAction = options.pinnedItems?.some((item) => item.value === previous);
    const index = previousIndex !== -1 && !(query && firstMatch && previousIsAction)
      ? previousIndex : displayed.findIndex((item) => item.value === firstMatch);
    if (index !== -1) list.setSelectedIndex(index);
    list.onSelect = options.onSelect;
    list.onCancel = options.onBack;
  };
  rebuild();

  return {
    path: options.path,
    action: options.action ?? "Select",
    confirmLabel: options.spaceSelect ? `${keyLabel("tui.select.confirm")}/Space` : undefined,
    get hasSearchQuery() { return !!options.search && input.getValue().length > 0; },
    get focused() { return input.focused; },
    set focused(value) { input.focused = value; },
    invalidate() { input.invalidate(); list.invalidate(); },
    render(width) {
      const theme = ctx.ui.theme;
      const lines: string[] = [];
      if (options.search) {
        lines.push(theme.fg("muted", options.search === "models" ? "Search models (regex)" : `Search ${options.search}`));
        lines.push(...input.render(width), "");
      }
      options.formatItems?.(displayed, width);
      if (error) {
        lines.push(...wrapTextWithAnsi(theme.fg("error", error), width));
      } else {
        if (!matchingCount) lines.push(...wrapTextWithAnsi(theme.fg("muted", options.empty), width));
        if (displayed.length) lines.push(...list.render(width));
      }
      if (options.legend) lines.push("", theme.fg("muted", options.legend));
      const selected = list.getSelectedItem();
      if (options.detail && selected) {
        // A fixed three-line help area prevents the footer jumping between rows.
        const wrapped = wrapTextWithAnsi(options.detail(selected), width);
        const detail = wrapped.slice(0, 3);
        if (wrapped.length > 3) detail[2] = truncateToWidth(detail[2], Math.max(0, width - 1)) + "…";
        lines.push("", ...detail.map((line) => theme.fg("muted", line)), ...Array(3 - detail.length).fill(""));
      }
      if (options.search) lines.push("", theme.fg("dim", `${matchingCount} of ${originals.length} ${options.search}`));
      return lines.map((line) => truncateToWidth(line, width));
    },
    handleInput(data) {
      const kb = getKeybindings();
      if (kb.matches(data, "tui.select.cancel")) { options.onBack(); return; }
      if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") ||
          kb.matches(data, "tui.select.confirm")) {
        if (displayed.length && !error) list.handleInput(data);
        else if (options.action === "Back" && kb.matches(data, "tui.select.confirm")) options.onBack();
        return;
      }
      if ((!options.search || options.spaceSelect) && data === " ") {
        if (displayed.length && !error) options.onSelect(list.getSelectedItem()!);
        return;
      }
      if (options.search) {
        const before = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== before) rebuild();
      }
    },
    handleMouse(event) {
      const offset = (options.search ? 3 : 0) + (!matchingCount ? wrapTextWithAnsi(ctx.ui.theme.fg("muted", options.empty), event.width).length : 0);
      if (options.search && event.y === 1) return input.handleMouse({ ...event, y: 0 });
      if (event.y < offset || event.y >= offset + list.render(event.width).length || error) return;
      return list.handleMouse({ ...event, y: event.y - offset });
    },
  };
}

const MANAGED_TOOLS = new Set(["ask_question", "subagent", "subagent_interrupt", "subagent_message", "subagents_list"]);
type ListField = "tools" | "skills" | "subagentAgents";
type AgentField = "model" | "thinking" | "modelFallback" | ListField;
const FIELD_LABELS: Record<AgentField, string> = {
  model: "Model", thinking: "Thinking", tools: "Tools", skills: "Skills",
  subagentAgents: "Spawnable agents", modelFallback: "Model fallback",
};
const FIELD_HELP: Record<ListField, string> = {
  tools: "Optional tools only. ask_question is always included; spawning tools are managed by Spawnable agents. Empty means no optional tools.",
  skills: "Startup skill prompts, not a skill-access allowlist. Empty means no startup skill prompts.",
  subagentAgents: "Agents this agent may spawn. A nonempty list enables managed spawning tools; empty disables spawning.",
};

function optionalTools(tools: string[]): string[] {
  return [...new Set(tools)].filter((tool) => !MANAGED_TOOLS.has(tool));
}

function agentValues(deps: SubagentSettingsDeps, name: string) {
  const defaults = deps.markdownDefaults(name);
  const override = deps.configState.get().agents[name] ?? {};
  const model = override.model ?? defaults.model;
  const piAgent = defaults.cli !== "claude";
  const supportsThinking = piAgent && deps.modelSupportsReasoning(model);
  const fallback = override.modelFallback !== undefined ? override.modelFallback : defaults.modelFallback;
  const tools = override.tools ?? defaults.tools;
  const skills = override.skills ?? defaults.skills;
  const spawnable = override.subagentAgents ?? defaults.subagentAgents;
  const source = (field: AgentField) => override[field] !== undefined ? "Custom override" : "Agent default";
  return {
    model: model ?? "Pi default",
    modelSource: override.model ? "Custom override" : defaults.model ? "Agent default" : "Pi default",
    thinking: supportsThinking ? override.thinking ?? defaults.thinking ?? "Pi default" : "off",
    thinkingSource: !piAgent ? "Unsupported for cli:claude (Pi only)" : !supportsThinking ? "This model does not support reasoning" :
      override.thinking ? "Custom override" : defaults.thinking ? "Agent default" : "Pi default",
    tools: tools === undefined ? "Parent's active tools" : optionalTools(tools).join(", ") || "No optional tools",
    toolsSource: `${tools === undefined ? "Parent default" : source("tools")} · ask_question always included; spawning tools managed separately`,
    skills: skills?.join(", ") || "No startup skill prompts",
    skillsSource: `${source("skills")} · Startup prompts, not a skill-access allowlist`,
    subagentAgents: spawnable?.join(", ") || "Spawning disabled",
    subagentAgentsSource: `${source("subagentAgents")} · ${spawnable?.length ? "Managed spawning tools enabled" : "No spawning tools"}`,
    modelFallback: fallback === undefined || fallback === null ? "Disabled" : fallback === "inherit" ? "Inherit parent model" : fallback,
    modelFallbackSource: source("modelFallback"),
    supportsThinking, piAgent, override, defaults,
  };
}

function padColumn(value: string, width: number): string {
  const text = truncateToWidth(value, width);
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function formatAgentItems(
  deps: SubagentSettingsDeps,
  names: string[],
  items: SelectItem[],
  width: number,
): void {
  const rows = names.map((name) => {
    const values = agentValues(deps, name);
    const model = values.model.includes("/") ? values.model.slice(values.model.indexOf("/") + 1) : values.model;
    const marked = Object.values(values.override).some((value) => value !== undefined);
    return { name, marked, model, thinking: values.thinking };
  });
  // Use the whole agent list, not just search matches, so filtering and levels
  // of different lengths never shift the model or thinking columns.
  const nameWidth = Math.min(20, Math.max(1, Math.floor(width / 3)),
    Math.max(1, ...rows.map((row) => visibleWidth(row.name) + (row.marked ? 1 : 0))));
  const thinkingWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.thinking)));
  const modelWidth = Math.max(0, Math.min(
    Math.max(0, ...rows.map((row) => visibleWidth(row.model))),
    width - 4 - nameWidth - FIELD_GAP.length * 2 - thinkingWidth, // selection prefix, gaps, thinking
  ));
  const labels = new Map(rows.map((row) => {
    // Reserve the marker's column even when a long name needs abbreviation.
    const name = row.marked ? truncateToWidth(row.name, Math.max(0, nameWidth - 1)) + "*" : row.name;
    return [row.name, `${padColumn(name, nameWidth)}${FIELD_GAP}${padColumn(row.model, modelWidth)}${FIELD_GAP}${row.thinking}`];
  }));
  for (const item of items) item.label = labels.get(item.value)!;
}

function keyLabel(action: Keybinding): string {
  const key = getKeybindings().getKeys(action)[0];
  if (!key) return "Unbound";
  return ({ up: "↑", down: "↓", enter: "Enter", escape: "Esc", tab: "Tab" } as Record<string, string>)[key]
    ?? key.split("+").map((part) => part[0].toUpperCase() + part.slice(1)).join("+");
}

/** Wrap whole shortcut/action pairs, rather than separating “Esc” from “Back”. */
function shortcutLines(chunks: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const chunk of chunks) {
    if (line && visibleWidth(`${line} · ${chunk}`) > width) { lines.push(line); line = ""; }
    if (visibleWidth(chunk) > width) { if (line) lines.push(line); lines.push(...wrapTextWithAnsi(chunk, width)); line = ""; }
    else line = line ? `${line} · ${chunk}` : chunk;
  }
  if (line) lines.push(line);
  return lines;
}

function backendLabel(value: string): string {
  return ({ auto: "Automatic", tmux: "tmux", herdr: "Herdr", background: "Background" } as Record<string, string>)[value] ?? value;
}

function effectiveBackendLabel(preference: string): string {
  if (preference !== "auto") return backendLabel(preference);
  try { return `Automatic (${backendLabel(resolveSurfaceBackend())})`; }
  catch { return "Automatic (unavailable)"; }
}

function orphanSummary(sessionDir: string, currentSessionId: string, runningFiles: string[]): string {
  try {
    const candidates = findOrphanArtifactDirs(sessionDir, {
      currentSessionId, runningSessionFiles: runningFiles, minAgeMs: 0,
    });
    if (!candidates.length) return "Nothing to clean";
    const files = candidates.reduce((sum, c) => sum + c.fileCount, 0);
    const kb = Math.round(candidates.reduce((sum, c) => sum + c.sizeBytes, 0) / 1024);
    return `${candidates.length} orphan${candidates.length === 1 ? "" : "s"} · ${files} files · ${kb} KB`;
  } catch { return "Unavailable"; }
}

function orphanView(ctx: ExtensionContext, deps: SubagentSettingsDeps, back: () => void): SettingsView {
  const dirs = deps.sessionDirs(ctx);
  const candidates = dirs ? findOrphanArtifactDirs(dirs.sessionDir, {
    currentSessionId: dirs.sessionId, runningSessionFiles: deps.runningSessionFiles(), minAgeMs: 0,
  }) : [];
  let confirming = false;
  return selectionView(ctx, {
    path: ["Orphan cleanup"], action: candidates.length ? "Review deletion" : "Back",
    items: candidates.map((candidate) => ({
      value: candidate.dir,
      label: `${basename(candidate.dir)} · ${candidate.fileCount} files · ${Math.round(candidate.sizeBytes / 1024)} KB`,
    })),
    empty: dirs ? "No orphan artifacts. Nothing to clean." : "Open a persistent session to inspect orphan artifacts.",
    detail: (item) => `Only recognized extension artifacts in ${basename(item.value)} will be deleted. Other files are preserved.`,
    onBack: back,
    onSelect: async (item) => {
      if (!dirs || confirming) return;
      confirming = true;
      try {
        const ok = await ctx.ui.confirm("Delete orphan artifacts?",
          `Delete recognized extension artifacts only in ${basename(item.value)}? Other files will be preserved. ` +
          "Ensure no child from this deleted parent is running in another Pi process.");
        if (!ok) return;
        const result = cleanOrphanArtifactDirs(dirs.sessionDir, {
          currentSessionId: dirs.sessionId,
          runningSessionFiles: deps.runningSessionFiles(),
          minAgeMs: 0,
          targetSessionId: basename(item.value),
        });
        if (result.errors.length) ctx.ui.notify(`Cleanup failed: ${result.errors.map((e) => e.error).join("; ")}`, "error");
        else if (!result.candidates.length) ctx.ui.notify("Nothing deleted: this directory is no longer eligible for cleanup.", "info");
        else ctx.ui.notify(`Deleted ${result.cleanedFilesCount} extension artifact files.`, "info");
        back();
      } catch (error) {
        ctx.ui.notify(`Cleanup failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally { confirming = false; }
    },
  });
}

/** Each checkbox change persists immediately; leaving the picker never discards edits. */
function checkboxView(
  ctx: ExtensionContext,
  deps: SubagentSettingsDeps,
  name: string,
  field: ListField,
  initial: string[],
  save: (selected: string[]) => void,
  reset: () => void,
  back: () => void,
): SettingsView {
  const catalog = field === "tools" ? deps.toolCatalog().filter((item) => !MANAGED_TOOLS.has(item.name)) :
    field === "skills" ? deps.skillCatalog() : deps.discoverAgents();
  const choices = new Map<string, { name: string; description?: string; available?: boolean }>(catalog.map((item) => [item.name, item]));
  let selected = new Set(field === "tools" ? optionalTools(initial) : initial);
  for (const entry of selected) {
    if (!choices.has(entry)) choices.set(entry, { name: entry, available: false });
  }
  const resetId = "\u0000reset";
  const view = selectionView(ctx, {
    path: [name, FIELD_LABELS[field]], search: field === "subagentAgents" ? "agents" : field,
    action: "Toggle", spaceSelect: true,
    initial: choices.keys().next().value,
    pinnedItems: [{ value: resetId, label: "Reset field to agent defaults" }],
    items: [...choices.keys()].map((value) => ({ value, label: value })),
    empty: "No matching choices. Clear or change the search.",
    formatItems: (items) => {
      for (const item of items) {
        if (item.value !== resetId) item.label = `[${selected.has(item.value) ? "x" : " "}] ${item.value}${choices.get(item.value)?.available === false ? " (unavailable)" : ""}`;
      }
    },
    detail: (item) => item.value === resetId ? "Remove this field's override and use profile defaults." :
      `${item.value}${choices.get(item.value)?.available === false ? " is unavailable; existing selections can be retained or removed, not added." : ""}${choices.get(item.value)?.description ? ` · ${choices.get(item.value)!.description}` : ""}`,
    onSelect: (item) => {
      try {
        if (item.value === resetId) { reset(); return; }
        const next = new Set(selected);
        if (next.has(item.value)) next.delete(item.value);
        else if (choices.get(item.value)?.available !== false) next.add(item.value);
        else return;
        // The UI reflects the new selection only after the atomic config write succeeds.
        save([...next]);
        selected = next;
      } catch (error) {
        ctx.ui.notify(`Could not save ${FIELD_LABELS[field]}: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
    onBack: back,
  });
  const render = view.render.bind(view);
  view.render = (width) => [...render(width), "", ...wrapTextWithAnsi(ctx.ui.theme.fg("muted", FIELD_HELP[field]), width)];
  return view;
}

function agentView(
  ctx: ExtensionContext,
  deps: SubagentSettingsDeps,
  name: string,
  push: (view: SettingsView) => void,
  back: () => void,
): SettingsView {
  const items: SelectItem[] = [
    { value: "model", label: "Model" },
    { value: "thinking", label: "Thinking" },
    { value: "modelFallback", label: FIELD_LABELS.modelFallback },
    { value: "tools", label: FIELD_LABELS.tools },
    { value: "subagentAgents", label: FIELD_LABELS.subagentAgents },
    { value: "skills", label: FIELD_LABELS.skills },
    { value: "reset", label: "Reset to agent defaults" },
  ];
  const list = new SelectList(items, items.length, getSelectListTheme());
  list.onCancel = back;
  const update = <F extends AgentField>(field: F, selected: AgentOverride[F]) => {
    deps.configState.update((draft) => {
      const override = { ...(draft.agents[name] ?? {}) };
      if (selected === undefined) delete override[field];
      else override[field] = selected;
      draft.agents[name] = override;
    });
  };
  const save = <F extends AgentField>(field: F, selected: AgentOverride[F]) => {
    update(field, selected);
    back(); // Pop only the picker; keep the agent detail page open.
  };
  const resetId = "\u0000reset";
  list.onSelect = (item) => {
    const values = agentValues(deps, name);
    if (item.value === "reset") {
      if (!Object.keys(values.override).length) return;
      deps.configState.update((draft) => { delete draft.agents[name]; });
    } else if (item.value === "model") {
      const current = values.override.model ?? values.defaults.model;
      push(selectionView(ctx, {
        path: [name, "Model"], search: "models", initial: current,
        items: [...deps.registryModels(current).map((model) => ({ value: model, label: model })),
          { value: resetId, label: "Reset field to agent defaults" }],
        empty: "No matching models. Clear or change the search.",
        detail: (selected) => selected.value === resetId ? "Remove the model override for new launches." : selected.value,
        onSelect: (selected) => save("model", selected.value === resetId ? undefined : selected.value), onBack: back,
      }));
    } else if (item.value === "thinking" && values.supportsThinking) {
      const current = values.override.thinking ?? values.defaults.thinking;
      const levels = uniquePreferred([current], STANDARD_THINKING_LEVELS);
      push(selectionView(ctx, {
        path: [name, "Thinking"], initial: current,
        items: [...levels.map((level) => ({ value: level, label: level })),
          { value: resetId, label: "Reset field to agent defaults" }],
        empty: "No thinking levels available.",
        detail: () => "Reasoning effort for new launches of this agent.",
        onSelect: (selected) => save("thinking", selected.value === resetId ? undefined : selected.value), onBack: back,
      }));
    } else if (values.piAgent && ["tools", "skills", "subagentAgents"].includes(item.value)) {
      const field = item.value as ListField;
      const current = values.override[field] ?? values.defaults[field] ?? (field === "tools" ? deps.parentActiveTools() : []);
      push(checkboxView(ctx, deps, name, field, current,
        (selected) => update(field, selected), () => save(field, undefined), back));
    } else if (values.piAgent && item.value === "modelFallback") {
      const current = values.override.modelFallback !== undefined ? values.override.modelFallback : values.defaults.modelFallback;
      const disabledId = "\u0000disabled";
      const models = deps.registryModels();
      const choices = uniquePreferred([current === null || current === "inherit" ? undefined : current], models);
      push(selectionView(ctx, {
        path: [name, FIELD_LABELS.modelFallback], search: "models", initial: current ?? disabledId,
        items: [
          { value: disabledId, label: "Disabled (no model fallback)" },
          { value: "inherit", label: "Inherit parent model" },
          ...choices.filter((model) => model !== "inherit").map((model) => ({
            value: model, label: `${model}${models.includes(model) ? "" : " (unavailable)"}`,
          })),
          { value: resetId, label: "Reset field to agent defaults" },
        ],
        empty: "No matching models. Clear or change the search.",
        detail: (selected) => selected.value === disabledId ? "Explicitly disable fallback for new launches." :
          selected.value === "inherit" ? "Use the parent model if the primary model cannot be used." :
          selected.value === resetId ? "Remove the fallback override and use profile defaults." : selected.value,
        onSelect: (selected) => save("modelFallback", selected.value === disabledId ? null : selected.value === resetId ? undefined : selected.value),
        onBack: back,
      }));
    }
  };
  // Only actual rows are clickable; group gaps and the shared help are not.
  let rowLines: number[] = [];
  return {
    path: [name], action: "Edit", hasSearchQuery: false, focused: false,
    hints: ["Delete Reset"],
    invalidate() { list.invalidate(); },
    render(width) {
      const values = agentValues(deps, name);
      const theme = ctx.ui.theme;
      const selected = list.getSelectedItem()?.value;
      const labelWidth = Math.max(...Object.values(FIELD_LABELS).map(visibleWidth));
      const valueWidth = Math.max(0, width - 2 - labelWidth - FIELD_GAP.length);
      const memberships = {
        tools: optionalTools(values.override.tools ?? values.defaults.tools ?? deps.parentActiveTools()),
        subagentAgents: values.override.subagentAgents ?? values.defaults.subagentAgents ?? [],
        skills: values.override.skills ?? values.defaults.skills ?? [],
      };
      const explanations: Record<AgentField, string> = {
        model: "Primary model for new launches. Delete restores the profile default.",
        thinking: values.supportsThinking ? "Reasoning effort for new launches." : values.thinkingSource,
        modelFallback: "Used when the primary model cannot be used. Inherit uses the parent model; Disabled means no fallback.",
        ...FIELD_HELP,
      };
      const lines: string[] = [];
      rowLines = [];
      for (const [index, item] of items.entries()) {
        if (index === 3 || index === 6) lines.push("");
        rowLines.push(lines.length);
        const active = item.value === selected;
        const prefix = active ? "→ " : "  ";
        let value = "";
        if (item.value !== "reset") {
          const field = item.value as AgentField;
          value = !values.piAgent && field !== "model" && field !== "thinking" ? "Unsupported for cli:claude" : values[field];
          if (values.piAgent && field in memberships) {
            const entries = memberships[field as ListField];
            if (entries.length && visibleWidth(value) > valueWidth) {
              const noun = field === "subagentAgents" ? "agent" : field === "skills" ? "skill" : "tool";
              value = `${entries.length} ${noun}${entries.length === 1 ? "" : "s"}`;
            }
          } else if ((field === "model" || field === "modelFallback") && visibleWidth(value) > valueWidth && value.includes("/")) {
            value = value.slice(value.indexOf("/") + 1);
          }
        }
        const row = item.value === "reset" ? prefix + item.label :
          `${prefix}${padColumn(item.label, labelWidth)}${FIELD_GAP}${truncateToWidth(value, valueWidth)}`;
        const bounded = truncateToWidth(row, width);
        lines.push(active ? theme.fg("accent", theme.bold(bounded)) : bounded);
      }
      // A single fixed-height help block keeps both layout and footer steady.
      // Large memberships live in their picker rather than expanding this page.
      const helpLines = (text: string, count: number) => {
        const wrapped = wrapTextWithAnsi(text, width);
        const shown = wrapped.slice(0, count);
        if (wrapped.length > count) shown[count - 1] = truncateToWidth(shown[count - 1], Math.max(0, width - 1)) + "…";
        return [...shown, ...Array(Math.max(0, count - shown.length)).fill("")];
      };
      lines.push("");
      if (selected === "reset") {
        const hasOverrides = Object.keys(values.override).length > 0;
        lines.push(...helpLines(hasOverrides ? "Remove all custom overrides" : "Already using agent defaults", 1),
          ...helpLines("Restore every field to its profile default.", 2),
          ...helpLines("Applies only to new launches; running and resumed sessions are unchanged.", 2));
      } else if (selected) {
        const field = selected as AgentField;
        const unsupported = !values.piAgent && field !== "model";
        const source = values.override[field] !== undefined ? "Custom override" :
          field === "tools" && values.defaults.tools === undefined ? "Parent default" :
          (field === "model" && values.defaults.model === undefined || field === "thinking" && values.defaults.thinking === undefined) ? "Pi default" : "Agent default";
        const count = field in memberships ? memberships[field as ListField].length : 0;
        const noun = field === "subagentAgents" ? "spawnable agent" : field === "skills" ? "startup skill prompt" : "optional tool";
        const fullValue = field in memberships ?
          `${count} ${noun}${count === 1 ? "" : "s"}. Edit to inspect full membership.` : values[field];
        lines.push(...helpLines(`Source: ${source}${unsupported ? " · Unsupported for cli:claude" : ""}`, 1),
          ...helpLines(`Value: ${fullValue}`, 2),
          ...helpLines(unsupported ? "Pi only; saved overrides do not affect Claude CLI launches." : explanations[field], 2));
      }
      return lines.map((line, index) => index > rowLines.at(-1)! ? theme.fg("muted", line) : line);
    },
    handleInput(data) {
      if (matchesKey(data, Key.delete)) {
        const field = list.getSelectedItem()?.value as AgentField | "reset" | undefined;
        const values = agentValues(deps, name);
        if (field && field !== "reset" && (values.piAgent || field === "model")) update(field, undefined);
      } else if (data === " ") list.onSelect?.(list.getSelectedItem()!);
      else list.handleInput(data);
    },
    handleMouse(event) {
      const index = rowLines.indexOf(event.y);
      if (index === -1) return;
      return list.handleMouse({ ...event, y: index, height: items.length });
    },
  };
}

export async function showSubagentSettings(ctx: ExtensionCommandContext, deps: SubagentSettingsDeps): Promise<void> {
  if (!ctx.hasUI) { ctx.ui.notify("Subagent settings require interactive mode.", "warning"); return; }
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const tabs = ["Agents", "General"] as const;
    let activeTab: typeof tabs[number] = "Agents";
    let focused = false;
    const stack: SettingsView[] = [];
    const push = (view: SettingsView) => { stack.push(view); tui.requestRender(); };
    const back = () => { stack.pop(); tui.requestRender(); };
    const agents = deps.discoverAgents();
    const agentNames = agents.map((agent) => agent.name);
    // Filesystem scans and CLI availability checks must not run on every keystroke.
    let cleanupSummary = "No session";
    let backendSummary = "";
    const refreshGeneral = () => {
      const dirs = deps.sessionDirs(ctx);
      cleanupSummary = dirs ? orphanSummary(dirs.sessionDir, dirs.sessionId, deps.runningSessionFiles()) : "No session";
      backendSummary = effectiveBackendLabel(deps.configState.get().multiplexing.backend);
    };
    refreshGeneral();
    const panels: Record<typeof tabs[number], SettingsView> = {
      Agents: selectionView(ctx, {
        path: [], action: "Open", search: "agents", legend: "* Saved overrides",
        items: agents.map((agent) => ({ value: agent.name, label: agent.name })),
        formatItems: (items, width) => formatAgentItems(deps, agentNames, items, width),
        detail: (item) => agents.find((agent) => agent.name === item.value)?.description ?? `Model, thinking, tools, spawnable agents, startup skills, and fallback defaults for ${item.value}.`,
        empty: agents.length ? "No matching agents. Clear or change the search." : "No agents found. Add an agent definition to your agents directory.",
        onSelect: (item) => push(agentView(ctx, deps, item.value, push, back)), onBack: () => done(),
      }),
      General: selectionView(ctx, {
        path: [], action: "Change",
        items: [
          { value: "backend", label: "Launch surface" },
          { value: "status-widget", label: "Status widget" },
          { value: "orphan-cleanup", label: "Orphan cleanup" },
        ],
        empty: "No general settings available.",
        formatItems: (items, width) => {
          const config = deps.configState.get();
          const compact = width < 48;
          const labels: Record<string, string> = {
            backend: "Launch surface",
            "status-widget": "Status widget", "orphan-cleanup": "Orphan cleanup",
          };
          const labelWidth = Math.max(...Object.values(labels).map(visibleWidth));
          for (const item of items) {
            const value = item.value === "backend" ? backendSummary :
              item.value === "status-widget" ? config.status.enabled ? "On" : "Off" : cleanupSummary;
            const displayedValue = compact && item.value === "backend" ? value.replace(/^Automatic/, "Auto") : value;
            item.label = `${padColumn(labels[item.value], labelWidth)}${FIELD_GAP}${displayedValue}`;
          }
        },
        detail: (item) => item.value === "backend" ? `${backendSummary}. Where new subagents run. Automatic chooses an available surface.` :
          item.value === "status-widget" ? "Show live subagent progress above the editor. Enter toggles On / Off." :
          "Review artifacts from deleted parent sessions. Deletion requires confirmation.",
        onSelect: (item) => {
          if (item.value === "status-widget") {
            const enabled = !deps.configState.get().status.enabled;
            deps.configState.update((draft) => { draft.status.enabled = enabled; });
            deps.setStatusEnabled(enabled);
          } else if (item.value === "orphan-cleanup") {
            push(orphanView(ctx, deps, () => { refreshGeneral(); back(); }));
          } else {
            const available = { tmux: isTmuxAvailable(), herdr: isHerdrAvailable() };
            push(selectionView(ctx, {
              path: ["Launch surface"], initial: deps.configState.get().multiplexing.backend,
              items: [
                { value: "auto", label: "Automatic" },
                { value: "tmux", label: "tmux" },
                { value: "herdr", label: "Herdr" },
                { value: "background", label: "Background" },
              ],
              empty: "No launch surfaces available.",
              formatItems: (items) => {
                for (const choice of items) {
                  const unavailable = (choice.value === "tmux" && !available.tmux) || (choice.value === "herdr" && !available.herdr);
                  choice.label = `${backendLabel(choice.value)}${unavailable ? " (unavailable)" : ""}`;
                }
              },
              detail: (choice) => ({
                auto: "Choose an available surface automatically.", tmux: "Open interactive terminal panes in tmux.",
                herdr: "Open interactive sessions in Herdr.", background: "Run without an interactive pane.",
              })[choice.value] ?? "",
              onSelect: (choice) => {
                const backend = choice.value as "auto" | "tmux" | "herdr" | "background";
                deps.configState.update((draft) => { draft.multiplexing.backend = backend; });
                deps.setBackendPreference(backend);
                refreshGeneral();
                back();
              }, onBack: back,
            }));
          }
        }, onBack: () => done(),
      }),
    };
    const current = () => stack.at(-1) ?? panels[activeTab];
    const tabLabels = () => tabs.map((tab) => tab === activeTab ? `[${tab}]` : tab);
    const headerHeight = 4;
    const switchTab = (tab: typeof tabs[number]) => {
      activeTab = tab;
      if (tab === "General") refreshGeneral();
      tui.requestRender();
    };
    const cycleTab = (direction: -1 | 1) => {
      const index = (tabs.indexOf(activeTab) + direction + tabs.length) % tabs.length;
      switchTab(tabs[index]);
    };
    return {
      get focused() { return focused; },
      set focused(value) { focused = value; current().focused = value; },
      invalidate() { for (const view of [...Object.values(panels), ...stack]) view.invalidate(); },
      render(width) {
        const inset = width > 4 ? 2 : 0;
        const innerWidth = Math.max(1, width - inset * 2);
        const view = current();
        view.focused = focused;
        const border = theme.fg("border", "─".repeat(innerWidth));
        const path = [activeTab, ...view.path];
        let breadcrumb = path.join(" › ");
        while (visibleWidth(breadcrumb) > innerWidth && path.length > 1) {
          path.shift();
          breadcrumb = `… › ${path.join(" › ")}`;
        }
        const navigation = stack.length
          ? theme.fg("muted", breadcrumb)
          : tabLabels().map((label, index) => tabs[index] === activeTab
            ? theme.fg("accent", theme.bold(label)) : theme.fg("muted", label)).join("  ");
        const navigationKeys = `${keyLabel("tui.select.up")}${keyLabel("tui.select.down")}`;
        const hints = [
          `${navigationKeys} Move`, `${view.confirmLabel ?? keyLabel("tui.select.confirm")} ${view.action}`,
          ...(!stack.length ? [
            view.hasSearchQuery ? "←→ Cursor" : "←→ Panel",
            `${keyLabel("tui.input.tab")}/Shift+Tab Panel`,
          ] : []),
          ...(view.hints ?? []),
          `${keyLabel("tui.select.cancel")} ${stack.length ? "Back" : "Close"}`,
        ];
        return [
          theme.fg("accent", theme.bold("Subagent settings")),
          theme.fg("dim", "Changes save immediately · New launches only"), navigation, border,
          ...view.render(innerWidth), border,
          ...shortcutLines(hints, innerWidth).map((line) => theme.fg("dim", line)),
        ].map((line) => truncateToWidth(" ".repeat(inset) + truncateToWidth(line, innerWidth), width));
      },
      handleInput(data) {
        if (!stack.length) {
          if (matchesKey(data, Key.shift("tab"))) { cycleTab(-1); return; }
          if (getKeybindings().matches(data, "tui.input.tab")) { cycleTab(1); return; }
          // Search owns horizontal arrows while a query exists, including at
          // its start/end. Never turn a caret movement into a panel switch.
          if (!current().hasSearchQuery) {
            if (matchesKey(data, Key.left)) { cycleTab(-1); return; }
            if (matchesKey(data, Key.right)) { cycleTab(1); return; }
          }
        }
        current().handleInput?.(data);
        tui.requestRender();
      },
      handleMouse(event) {
        const inset = event.width > 4 ? 2 : 0;
        const x = event.x - inset;
        if (!stack.length && event.y === 2 && event.button === "left" && event.type === "click") {
          let start = 0;
          for (const [index, label] of tabLabels().entries()) {
            const end = start + visibleWidth(label);
            if (x >= start && x < end) { switchTab(tabs[index]); return { handled: true, focus: true, render: true }; }
            start = end + 2;
          }
        }
        const innerWidth = Math.max(1, event.width - inset * 2);
        const view = current();
        const height = view.render(innerWidth).length;
        if (x < 0 || x >= innerWidth || event.y < headerHeight || event.y >= headerHeight + height) return;
        return view.handleMouse?.({ ...event, x, y: event.y - headerHeight, width: innerWidth, height });
      },
    };
  });
}

export function registerSubagentSettingsCommand(pi: ExtensionAPI, deps: SubagentSettingsDeps): void {
  pi.registerCommand("subagent-settings", {
    description: "Subagent settings: model/thinking, tools, spawnable agents, startup skills, fallback, surface/status, cleanup",
    handler: async (_args, ctx) => { await showSubagentSettings(ctx, deps); },
  });
}
