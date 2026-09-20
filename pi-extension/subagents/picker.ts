import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Input, SelectList, truncateToWidth, type Focusable, type SelectItem } from "@mariozechner/pi-tui";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export interface PickerConfig {
  enabled: boolean;
}

export interface SpawnPickerDefaults {
  model?: string;
  thinking?: string;
  parentModel?: string;
  parentThinking?: string;
}

export interface SpawnPickerResult {
  model: string;
  thinking?: string;
}

export function parsePickerConfig(raw: unknown, source = "config.json"): PickerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid subagent picker config in ${source}: root must be an object`);
  }
  const picker = (raw as Record<string, unknown>).picker;
  if (picker === undefined) return { enabled: false };
  if (!picker || typeof picker !== "object" || Array.isArray(picker)) {
    throw new Error(`Invalid subagent picker config in ${source}: picker must be an object`);
  }
  const unsupported = Object.keys(picker).filter((key) => key !== "enabled");
  if (unsupported.length > 0) {
    throw new Error(`Invalid subagent picker config in ${source}: picker has unsupported key(s): ${unsupported.join(", ")}`);
  }
  const enabled = (picker as Record<string, unknown>).enabled ?? false;
  if (typeof enabled !== "boolean") {
    throw new Error(`Invalid subagent picker config in ${source}: picker.enabled must be a boolean`);
  }
  return { enabled };
}

export function loadPickerConfig(
  configPath = DEFAULT_CONFIG_PATH,
  examplePath = EXAMPLE_CONFIG_PATH,
): PickerConfig {
  let source = configPath;
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = examplePath;
    raw = readFileSync(examplePath, "utf8");
  }
  try {
    return parsePickerConfig(JSON.parse(raw), source);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in subagent config ${source}: ${error.message}`);
    }
    throw error;
  }
}

export function resolvePickerEnabled(
  configured: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const override = env.PI_SUBAGENT_PICKER;
  if (override === undefined || override === "") return configured;
  if (override === "1") return true;
  if (override === "0") return false;
  throw new Error(`Invalid PI_SUBAGENT_PICKER=${override}; expected 0 or 1`);
}

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

async function selectModelWithRegex(
  ctx: ExtensionContext,
  models: string[],
): Promise<string | null> {
  return await ctx.ui.custom<string | null>((tui, theme, keybindings, done) => {
    const input = new Input();
    let pattern = "";
    let regexError: string | undefined;
    let selectList: SelectList;

    const listTheme = {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };

    const rebuildList = () => {
      const filtered = regexFilterModels(models, pattern);
      regexError = filtered.error;
      const items: SelectItem[] = filtered.matches.map((model) => ({ value: model, label: model }));
      selectList = new SelectList(items, Math.min(Math.max(items.length, 1), 12), listTheme);
      selectList.onSelect = (item) => done(item.value);
      selectList.onCancel = () => done(null);
    };
    rebuildList();

    const component: Focusable & {
      render(width: number): string[];
      handleInput(data: string): void;
      invalidate(): void;
    } = {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      render(width: number) {
        const lines = [
          truncateToWidth(theme.fg("accent", theme.bold("Select subagent model")), width),
          ...input.render(width),
        ];
        if (regexError) {
          lines.push(truncateToWidth(theme.fg("error", `Invalid regex: ${regexError}`), width));
        }
        lines.push(...selectList.render(width));
        lines.push(truncateToWidth(theme.fg("dim", "type regex • ↑↓ navigate • enter select • esc cancel"), width));
        return lines.map((line) => truncateToWidth(line, width));
      },
      handleInput(data: string) {
        if (keybindings.matches(data, "tui.select.cancel")) {
          done(null);
          return;
        }
        if (
          keybindings.matches(data, "tui.select.up") ||
          keybindings.matches(data, "tui.select.down") ||
          keybindings.matches(data, "tui.select.confirm")
        ) {
          selectList.handleInput(data);
          tui.requestRender();
          return;
        }
        const before = input.getValue();
        input.handleInput(data);
        const after = input.getValue();
        if (after !== before) {
          pattern = after;
          rebuildList();
        }
        tui.requestRender();
      },
      invalidate() {
        input.invalidate();
        selectList.invalidate();
      },
    };
    return component;
  });
}

export async function showSpawnPicker(
  ctx: ExtensionContext,
  defaults: SpawnPickerDefaults,
): Promise<SpawnPickerResult | null> {
  const registryModels = ctx.modelRegistry.getAll().map((model) => `${model.provider}/${model.id}`);
  const models = uniquePreferred([defaults.model, defaults.parentModel], registryModels);
  if (models.length === 0) {
    ctx.ui.notify("No models are available for the subagent picker.", "warning");
    return null;
  }

  const model = await selectModelWithRegex(ctx, models);
  if (!model) return null;

  const match = ctx.modelRegistry.getAll().find(
    (candidate) => `${candidate.provider}/${candidate.id}` === model || candidate.id === model,
  );
  const standardLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const levels = match?.reasoning === false
    ? ["off"]
    : uniquePreferred([defaults.thinking, defaults.parentThinking], standardLevels);
  const thinking = await ctx.ui.select("Select subagent thinking level", levels);
  if (!thinking) return null;

  return { model, thinking };
}

export function canShowSpawnPicker(ctx: ExtensionContext): boolean {
  if (!ctx.hasUI) return false;
  const mode = (ctx as ExtensionContext & { mode?: string }).mode;
  return mode === undefined || mode === "tui";
}
