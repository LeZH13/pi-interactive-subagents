/**
 * Unified subagent configuration: status widget, surface backend preference,
 * and per-agent model/thinking overrides.
 *
 * `config.json` in the package root is the single persisted store, edited via
 * `/subagent-settings` (live-apply + immediate atomic write) and read at
 * spawn/resume time. Every accessor tolerates a missing or legacy file:
 * absent keys fall back to defaults and the legacy `picker` key is ignored.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
export const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export type AgentOverride = {
  model?: string;
  thinking?: string;
};

export interface SubagentsConfig {
  status: { enabled: boolean };
  multiplexing: { backend: "auto" | "tmux" | "herdr" | "background" };
  agents: Record<string, AgentOverride>;
}

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  status: { enabled: true },
  multiplexing: { backend: "auto" },
  agents: {},
};

const VALID_BACKENDS = ["auto", "tmux", "herdr", "background"] as const;

function invalid(source: string, message: string): Error {
  return new Error(`Invalid subagent config in ${source}: ${message}`);
}

function requireObject(value: unknown, source: string, field: string): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw invalid(source, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireBoolean(value: unknown, source: string, field: string): boolean {
  if (typeof value !== "boolean") throw invalid(source, `${field} must be a boolean`);
  return value;
}

function optionalTrimmedString(value: unknown, source: string, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw invalid(source, `${field} must be a string`);
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function rejectUnsupportedKeys(
  value: Record<string, unknown>,
  allowed: string[],
  source: string,
  field: string,
): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) {
    throw invalid(source, `${field} has unsupported key(s): ${unsupported.join(", ")}`);
  }
}

/**
 * Parse the full unified config. Unknown top-level keys are rejected except
 * the legacy `picker` key, which is silently ignored (it was removed in favor
 * of per-agent overrides; dropped on next save).
 */
export function parseSubagentsConfig(raw: unknown, source = "config.json"): SubagentsConfig {
  const root = requireObject(raw, source, "root");
  // Legacy `picker` key is tolerated here and dropped on save.
  rejectUnsupportedKeys(root, ["status", "multiplexing", "agents", "picker"], source, "root");

  // status
  let statusEnabled = DEFAULT_SUBAGENTS_CONFIG.status.enabled;
  if (root.status !== undefined) {
    const status = requireObject(root.status, source, "status");
    rejectUnsupportedKeys(status, ["enabled"], source, "status");
    statusEnabled = status.enabled === undefined
      ? DEFAULT_SUBAGENTS_CONFIG.status.enabled
      : requireBoolean(status.enabled, source, "status.enabled");
  }

  // multiplexing
  let backend: SubagentsConfig["multiplexing"]["backend"] = "auto";
  if (root.multiplexing !== undefined) {
    const multiplexing = requireObject(root.multiplexing, source, "multiplexing");
    rejectUnsupportedKeys(multiplexing, ["enabled", "backend"], source, "multiplexing");
    if (multiplexing.enabled !== undefined) {
      const enabled = requireBoolean(multiplexing.enabled, source, "multiplexing.enabled");
      if (!enabled && multiplexing.backend !== undefined && multiplexing.backend !== "background") {
        throw invalid(
          source,
          `multiplexing.enabled=false conflicts with backend=${multiplexing.backend}`,
        );
      }
      if (!enabled) backend = "background";
    }
    if (multiplexing.backend !== undefined) {
      if (typeof multiplexing.backend !== "string" || !VALID_BACKENDS.includes(multiplexing.backend as typeof VALID_BACKENDS[number])) {
        throw invalid(
          source,
          "multiplexing.backend must be auto, tmux, herdr, or background",
        );
      }
      backend = multiplexing.backend as SubagentsConfig["multiplexing"]["backend"];
    }
  }

  // agents
  const agents: Record<string, AgentOverride> = {};
  if (root.agents !== undefined) {
    const agentsRaw = requireObject(root.agents, source, "agents");
    for (const [name, entry] of Object.entries(agentsRaw)) {
      if (entry === undefined || entry === null) continue;
      const override = requireObject(entry, source, `agents.${name}`);
      rejectUnsupportedKeys(override, ["model", "thinking"], source, `agents.${name}`);
      const model = optionalTrimmedString(override.model, source, `agents.${name}.model`);
      const thinking = optionalTrimmedString(override.thinking, source, `agents.${name}.thinking`);
      if (model !== undefined || thinking !== undefined) {
        agents[name] = { ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
      }
    }
  }

  return { status: { enabled: statusEnabled }, multiplexing: { backend }, agents };
}

function readConfigFile(
  configPath: string,
  examplePath: string,
): { sourcePath: string; rawConfig: string } {
  try {
    return { sourcePath: configPath, rawConfig: readFileSync(configPath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return { sourcePath: examplePath, rawConfig: readFileSync(examplePath, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Missing subagent config. Expected ${configPath} or ${examplePath}.`);
    }
    throw error;
  }
}

export function loadSubagentsConfig(
  configPath = DEFAULT_CONFIG_PATH,
  examplePath = EXAMPLE_CONFIG_PATH,
): SubagentsConfig {
  const { sourcePath, rawConfig } = readConfigFile(configPath, examplePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in subagent config ${sourcePath}: ${detail}`);
  }
  return parseSubagentsConfig(parsed, sourcePath);
}

/**
 * Serialize the config. Only non-empty agent overrides are stored; the legacy
 * `picker` key is never written.
 */
export function serializeSubagentsConfig(config: SubagentsConfig): string {
  const agents: Record<string, AgentOverride> = {};
  for (const [name, override] of Object.entries(config.agents)) {
    const model = override.model?.trim();
    const thinking = override.thinking?.trim();
    if (model || thinking) {
      agents[name] = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
    }
  }
  return JSON.stringify(
    {
      status: { enabled: config.status.enabled },
      multiplexing: { backend: config.multiplexing.backend },
      agents,
    },
    null,
    2,
  ) + "\n";
}

/**
 * Atomically write the config (tmp file + rename), creating the parent
 * directory when needed.
 */
export function writeSubagentsConfig(
  config: SubagentsConfig,
  configPath = DEFAULT_CONFIG_PATH,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, serializeSubagentsConfig(config));
  renameSync(tmp, configPath);
}

/** True when a real config.json exists (as opposed to falling back to the example). */
export function hasSubagentsConfigFile(configPath = DEFAULT_CONFIG_PATH): boolean {
  return existsSync(configPath);
}

/**
 * Shared mutable runtime state for the unified config. Created once per
 * extension load from disk; mutated live by `/subagent-settings` (each
 * mutation persists immediately) and read by spawn/resume resolution.
 */
export function createSubagentsConfigState(
  initial: SubagentsConfig,
  configPath = DEFAULT_CONFIG_PATH,
): {
  get(): SubagentsConfig;
  update(mutator: (draft: SubagentsConfig) => void, options?: { pruneAgents?: string[] }): void;
  replace(next: SubagentsConfig): void;
} {
  let current: SubagentsConfig = structuredClone(initial);
  return {
    get(): SubagentsConfig {
      return structuredClone(current);
    },
    update(mutator: (draft: SubagentsConfig) => void, options?: { pruneAgents?: string[] }): void {
      const draft = structuredClone(current);
      mutator(draft);
      if (options?.pruneAgents) {
        const known = new Set(options.pruneAgents);
        for (const name of Object.keys(draft.agents)) {
          if (!known.has(name)) delete draft.agents[name];
        }
      }
      // Drop empty overrides and normalize whitespace.
      for (const [name, override] of Object.entries(draft.agents)) {
        const model = override.model?.trim();
        const thinking = override.thinking?.trim();
        if (!model && !thinking) delete draft.agents[name];
        else draft.agents[name] = { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
      }
      current = draft;
      writeSubagentsConfig(current, configPath);
    },
    replace(next: SubagentsConfig): void {
      current = structuredClone(next);
    },
  };
}

export type SubagentsConfigState = ReturnType<typeof createSubagentsConfigState>;
