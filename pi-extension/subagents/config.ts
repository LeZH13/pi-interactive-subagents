/**
 * Unified subagent configuration: status widget, surface backend preference,
 * and per-agent launch overrides.
 *
 * The durable store is `<agentDir>/extensions/pi-interactive-subagents/config.json`,
 * edited via `/subagent-settings` (live-apply + immediate atomic write) and read at
 * admission time (spawn and resume); resumes replay their original sandbox snapshot.
 * Package-local `config.json` is not used. Every accessor tolerates
 * a missing file or legacy content: absent keys fall back to defaults and the legacy
 * `picker` key is ignored.
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

/** Extension directory name used for durable user configuration. */
export const SUBAGENT_CONFIG_EXTENSION_DIR = "pi-interactive-subagents";

/** Resolve the durable user config path, honoring `PI_CODING_AGENT_DIR`. */
export function subagentsUserConfigPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "extensions", SUBAGENT_CONFIG_EXTENSION_DIR, "config.json");
}

/** Default path for every config read/write. Evaluated at call time. */
export function defaultSubagentsConfigPath(): string {
  return subagentsUserConfigPath();
}

export type AgentOverride = {
  model?: string;
  thinking?: string;
  /** Undefined uses the profile; true hides only from model discovery, not explicit spawning. */
  disableModelInvocation?: boolean;
  /** Undefined uses the profile; an empty array explicitly grants nothing. */
  tools?: string[];
  skills?: string[];
  subagentAgents?: string[];
  /** Undefined uses the profile, "inherit" uses the parent model, null disables retry. */
  modelFallback?: string | null;
  /** Undefined uses the profile default; null explicitly permits unlimited runs. */
  maxConcurrent?: number | null;
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

function optionalStringArray(value: unknown, source: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw invalid(source, `${field} must be an array of strings`);
  }
  return [...new Set(value.map((entry: string) => entry.trim()).filter(Boolean))];
}

/** Validate and normalize one override without losing explicit empty/disabled values. */
export function parseAgentOverride(raw: unknown, source = "config.json", field = "agent"): AgentOverride {
  const value = requireObject(raw, source, field);
  rejectUnsupportedKeys(value, ["model", "thinking", "disableModelInvocation", "tools", "skills", "subagentAgents", "modelFallback", "maxConcurrent"], source, field);
  const override: AgentOverride = {};
  if (value.disableModelInvocation !== undefined) {
    override.disableModelInvocation = requireBoolean(value.disableModelInvocation, source, `${field}.disableModelInvocation`);
  }
  for (const key of ["model", "thinking"] as const) {
    const normalized = optionalTrimmedString(value[key], source, `${field}.${key}`);
    if (normalized !== undefined) override[key] = normalized;
  }
  for (const key of ["tools", "skills", "subagentAgents"] as const) {
    const normalized = optionalStringArray(value[key], source, `${field}.${key}`);
    if (normalized !== undefined) override[key] = normalized;
  }
  const fallback = value.modelFallback === null
    ? null
    : optionalTrimmedString(value.modelFallback, source, `${field}.modelFallback`);
  if (fallback !== undefined) override.modelFallback = fallback;
  if (value.maxConcurrent !== undefined) {
    if (value.maxConcurrent !== null &&
        (typeof value.maxConcurrent !== "number" || !Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent <= 0)) {
      throw invalid(source, `${field}.maxConcurrent must be a positive safe integer or null`);
    }
    override.maxConcurrent = value.maxConcurrent as number | null;
  }
  return override;
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
      const override = parseAgentOverride(entry, source, `agents.${name}`);
      if (Object.keys(override).length > 0) agents[name] = override;
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
  configPath = defaultSubagentsConfigPath(),
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
    const normalized = parseAgentOverride(override, "config.json", `agents.${name}`);
    if (Object.keys(normalized).length > 0) agents[name] = normalized;
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
  configPath = defaultSubagentsConfigPath(),
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, serializeSubagentsConfig(config));
  renameSync(tmp, configPath);
}

/** True when a real config.json exists (as opposed to falling back to the example). */
export function hasSubagentsConfigFile(configPath = defaultSubagentsConfigPath()): boolean {
  return existsSync(configPath);
}

/**
 * Shared mutable runtime state for the unified config. Created once per
 * extension load from disk; mutated live by `/subagent-settings` (each
 * mutation persists immediately) and read by launch resolution and concurrency admission.
 */
export function createSubagentsConfigState(
  initial: SubagentsConfig,
  configPath = defaultSubagentsConfigPath(),
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
        const normalized = parseAgentOverride(override, configPath, `agents.${name}`);
        if (Object.keys(normalized).length === 0) delete draft.agents[name];
        else draft.agents[name] = normalized;
      }
      writeSubagentsConfig(draft, configPath);
      current = draft;
    },
    replace(next: SubagentsConfig): void {
      current = structuredClone(next);
    },
  };
}

export type SubagentsConfigState = ReturnType<typeof createSubagentsConfigState>;
