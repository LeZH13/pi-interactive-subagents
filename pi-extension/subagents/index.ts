import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getPowerShellConfig, keyHint } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  interruptSurface,
  sendCommand,
  sendLongCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  readScreen,
  getBackgroundSurfaceLogPath,
  closeAllBackgroundSurfaces,
  getSurfaceBackend,
  setSurfaceBackendPreference,
} from "./surface.ts";

import {
  countSessionEntryLines,
  findLastAssistantMessage,
  getNewEntries,
  getSessionId,
  getSubagentSessionDir,
  loadoutSidecarPath,
  readNameRegistry,
  readSubagentLoadout,
  registerName,
  restoreNameRegistration,
  resolveNameInRegistry,
  seedSubagentSessionFile,
  SUBAGENT_DISPATCH_PREFIX,
  summarizeSessionStats,
  writeSubagentLoadout,
  writeArtifactOwnershipMarker,
  type SessionStats,
  type SubagentLoadout,
} from "./session.ts";
import {
  createSubagentsConfigState,
  loadSubagentsConfig,
  type AgentOverride,
  type SubagentsConfigState,
} from "./config.ts";
import { registerSubagentSettingsCommand } from "./settings.ts";
import { registerSubagentsAuditCommand } from "./audit-command.ts";
import { hasBash, resolveBashGuardExtension, validateBashGuardExtension, validateShellSelection } from "./bash-guard.ts";
import { formatSubagentIdentity } from "./identity.ts";
import { canonicalSessionPath, claimSession, abandonStartingSession, enqueueMessage, pendingMessages, finalizeSession, type SessionOwner, type InboxMessage } from "./protocol.ts";
import {
  DEFAULT_STATUS_LINE_LIMIT,
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Survive /reload: clear timers and abort poll loops from the previous module load.
// /reload re-imports this file, giving fresh module-level state, but closures from
// the old module keep running. See https://github.com/HazAT/pi-interactive-subagents/issues/5
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");
const POLL_ABORT_KEY = Symbol.for("pi-subagents/poll-abort-controller");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
  const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
  if (prevAbort) prevAbort.abort();
  (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
}

function getModuleAbortSignal(): AbortSignal {
  return ((globalThis as any)[POLL_ABORT_KEY] as AbortController).signal;
}

const SubagentParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents. " +
      "Each profile's current concurrency policy applies per parent runtime, including startup, resume, and fallback.",
  }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional persistent name for follow-up messages and the pane/widget. Defaults to a unique agent-based name. " +
        "Explicit names already used in this parent session are rejected, including finished handles. " +
        "Use `agent`, not `name`, to select the profile.",
    }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  thinking: Type.Optional(
    Type.String({
      description:
        "Thinking / reasoning level override (e.g. 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', or token budget)",
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
});

const CLAUDE_MESSAGE_ERROR = "Claude CLI children do not support durable subagent messaging or ingestion acknowledgements. Messages and message-based resumes are refused; a Claude loadout cannot be replayed as Pi. Spawn a fresh child for further work.";

const SubagentMessageParams = Type.Object({
  name: Type.Optional(Type.String({
    description:
      "Exact display name of the subagent. Steers it if it is still running; resumes its session if it has finished. Mutually exclusive with `sessionPath`.",
  })),
  sessionPath: Type.Optional(Type.String({
    description:
      "Path to a recorded Pi subagent session (.jsonl), bypassing the name registry. Mutually exclusive with `name`. A finished-session resume requires its `.loadout.json`, current ownership metadata, and matching wrapper completion; unknown or foreign active ownership is refused.",
  })),
  message: Type.String({
    description:
      "The message to deliver: a follow-up instruction for a running subagent, or the next task for a resumed session.",
  }),
});

// Structured output is an acknowledgement, never a child completion result.
const SubagentActionOutputSchema = Type.Object({
  ok: Type.Boolean(),
  status: Type.Union([
    Type.Literal("started"),
    Type.Literal("queued"),
    Type.Literal("interrupt_requested"),
    Type.Literal("interrupt_already_requested"),
    Type.Literal("error"),
  ]),
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  agent: Type.Optional(Type.String()),
  sessionFile: Type.Optional(Type.String()),
  sessionId: Type.Optional(Type.String()),
  messageId: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
});

const SubagentListOutputSchema = Type.Object({
  agents: Type.Array(Type.Object({
    name: Type.String(),
    source: Type.Union([Type.Literal("package"), Type.Literal("global"), Type.Literal("project")]),
    description: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    thinking: Type.Optional(Type.String()),
    modelFallback: Type.Optional(Type.String()),
  })),
});

/** Project only public handles/acknowledgements; never tasks, identity, or launch scripts. */
function addStructuredSubagentResult<T extends { details: unknown }>(result: T) {
  const details = result.details as Record<string, unknown>;
  const failed = typeof details.error === "string";
  const structuredContent: Static<typeof SubagentActionOutputSchema> = {
    ok: !failed,
    status: failed ? "error" : details.status as Static<typeof SubagentActionOutputSchema>["status"],
  };
  for (const key of ["id", "name", "agent", "sessionFile", "sessionId", "messageId", "error"] as const) {
    if (typeof details[key] === "string") structuredContent[key] = details[key];
  }
  return { ...result, structuredContent };
}

function withSubagentStructuredOutput<P extends TSchema>(execute: ToolDefinition<P>["execute"]): ToolDefinition<P>["execute"] {
  return async (...args) => addStructuredSubagentResult(await execute(...args));
}

function listStructuredAgents(list: ListedAgentDefinition[]): Static<typeof SubagentListOutputSchema> {
  return {
    agents: list.map(({ name, source, description, model, thinking, modelFallback }) => ({
      name,
      source,
      ...(description !== undefined ? { description } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(modelFallback !== undefined ? { modelFallback } : {}),
    })),
  };
}

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

interface AgentDefaults {
  /** Omitted permits unlimited concurrent runs in each parent runtime. */
  maxConcurrent?: number;
  /** Invalid definitions still shadow lower-priority profiles, but cannot admit runs. */
  maxConcurrentError?: string;
  model?: string;
  modelFallback?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  /**
   * If set (non-empty), this agent is granted the full subagent spawning
   * toolset and may only spawn the listed agents. Presence of this field —
   * not the `tools` list — is what grants spawning. Enforced in the child via
   * the PI_SUBAGENT_ALLOWED env var.
   */
  subagentAgents?: string[];
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

type AgentSource = "package" | "global" | "project";

interface AgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
}

interface ListedAgentDefinition extends AgentDefinition {
  source: AgentSource;
}

/**
 * The full subagent lifecycle/spawning toolset registered by this extension.
 * An agent is granted these (and this extension is loaded into its child
 * process) only when its effective spawnable list is non-empty.
 */
const SPAWNING_TOOLS = [
  "subagent",
  "subagent_interrupt",
  "subagent_message",
  "subagents_list",
] as const;

/** Built-in tools pi provides natively — no extension needs to be loaded. */
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"]);

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

// ── Runtime tool-extension registration ─────────────────────────────────────
// `getToolExtensionPath` otherwise only knows a closed set of tool names. Other
// pi extensions that bundle a tool for subagents (e.g. a project-local
// extension exposing a bespoke tool) register its name → extension-file path
// here at load/session_start time so a child process can be launched with
// `--no-extensions` + an explicit `-e <path>` for it. Mirrors the legacy
// `subagents` extension's `registerToolExtension` hook.
const EXTRA_TOOL_EXTENSIONS = new Map<string, string>();
const RUNTIME_TOOL_EXTENSIONS = new Map<string, string>();
const UNRELOADABLE_RUNTIME_TOOLS = new Set<string>();

/** Freeze file sources relative to their registration context, never the child's cwd. */
function absoluteToolExtensionPath(path: string, baseDir = process.cwd()): string {
  return path.startsWith("builtin:") ? path : resolve(baseDir, path);
}

/** Capture reloadable sources, including tools currently inactive in the parent. */
function captureRuntimeToolExtensions(pi: ExtensionAPI): void {
  RUNTIME_TOOL_EXTENSIONS.clear();
  UNRELOADABLE_RUNTIME_TOOLS.clear();
  for (const tool of pi.getAllTools()) {
    if (BUILTIN_TOOLS.has(tool.name) || (SPAWNING_TOOLS as readonly string[]).includes(tool.name) ||
      (SUBAGENT_CONTROL_TOOLS as readonly string[]).includes(tool.name)) continue;
    const sourcePath = tool.sourceInfo?.path;
    const path = sourcePath && !sourcePath.startsWith("<")
      ? absoluteToolExtensionPath(sourcePath, tool.sourceInfo.baseDir)
      : undefined;
    if (path && (path.startsWith("builtin:") || existsSync(path))) {
      RUNTIME_TOOL_EXTENSIONS.set(tool.name, path);
    } else {
      UNRELOADABLE_RUNTIME_TOOLS.add(tool.name);
    }
  }
}

function getSubagentToolCatalog(pi: ExtensionAPI, cwd: string): Array<{ name: string; description?: string; available: boolean }> {
  captureRuntimeToolExtensions(pi);
  const builtinDescriptions: Record<string, string> = {
    read: "Read file contents.", write: "Create or overwrite files.", edit: "Make precise file edits.",
    bash: "Execute bash commands.", powershell: "Execute PowerShell commands on Windows.",
    grep: "Search file contents.", find: "Find files by name.", ls: "List directory contents.",
  };
  let powerShellAvailable = false;
  try {
    getPowerShellConfig();
    powerShellAvailable = true;
  } catch {}
  const catalog = new Map<string, { name: string; description?: string; available: boolean }>();
  for (const tool of pi.getAllTools()) {
    if ((SPAWNING_TOOLS as readonly string[]).includes(tool.name) ||
      (SUBAGENT_CONTROL_TOOLS as readonly string[]).includes(tool.name)) continue;
    catalog.set(tool.name, {
      name: tool.name,
      description: tool.description,
      available: tool.name === "powershell" ? powerShellAvailable :
        BUILTIN_TOOLS.has(tool.name) || !!getToolExtensionPath(tool.name, cwd),
    });
  }
  // CLI restrictions can remove built-ins from the parent's registry; explicit
  // child grants remain independent of that registry and of the parent's active set.
  for (const name of BUILTIN_TOOLS) {
    if (!catalog.has(name)) catalog.set(name, {
      name, description: builtinDescriptions[name], available: name !== "powershell" || powerShellAvailable,
    });
  }
  const bundledDescriptions: Record<string, string> = {
    codemode: "Execute code over allowed tools; does not grant additional tools.",
    tool_search: "Find registered tools by name or purpose.",
    web_enable: "Activate permitted pi-web-access tools for the next model request.",
    safe_bash: "Execute bash commands with dangerous-command filtering.",
  };
  for (const [name, description] of Object.entries(bundledDescriptions)) {
    if (!catalog.has(name)) catalog.set(name, {
      name, description, available: !!getToolExtensionPath(name, cwd),
    });
  }
  const bash = catalog.get("bash")!;
  bash.description = `${bash.description ?? builtinDescriptions.bash} Requires bash-guard in enforced deny mode. Choose bash or safe_bash, not both.`;
  const safeBash = catalog.get("safe_bash")!;
  safeBash.description = `${safeBash.description ?? bundledDescriptions.safe_bash} Uses its own filtering, not bash-guard. Choose bash or safe_bash, not both.`;
  return [...catalog.values()];
}

function getSubagentSkillCatalog(pi: ExtensionAPI): Array<{ name: string; description?: string }> {
  return pi.getCommands().filter((command) => command.source === "skill")
    .map((command) => ({ name: command.name.replace(/^skill:/, ""), description: command.description }));
}

function snapshotToolExtensionPaths(tools: string[], cwd: string): string[] {
  validateSubagentTools(tools, cwd);
  return [...new Set(tools.map((tool) => getToolExtensionPath(tool, cwd))
    .filter((path): path is string => !!path)
    .map((path) => absoluteToolExtensionPath(path)))];
}

function validateSubagentTools(tools: string[], cwd: string): void {
  validateShellSelection(tools);
  for (const tool of tools) {
    if (BUILTIN_TOOLS.has(tool) || (SUBAGENT_CONTROL_TOOLS as readonly string[]).includes(tool)) continue;
    if (!getToolExtensionPath(tool, cwd)) {
      throw new Error(`Cannot load subagent tool "${tool}": no reloadable backing extension. Register its source with registerToolExtension().`);
    }
  }
}

/** Register a backing source; relative file paths use the registration process's cwd. */
export function registerToolExtension(name: string, extensionPath: string): void {
  if (BUILTIN_TOOLS.has(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a built-in pi tool`);
  }
  if ((SPAWNING_TOOLS as readonly string[]).includes(name)) {
    throw new Error(`Cannot register custom tool "${name}": shadows a spawning tool`);
  }
  extensionPath = absoluteToolExtensionPath(extensionPath);
  const existing = EXTRA_TOOL_EXTENSIONS.get(name);
  if (existing === extensionPath) return; // idempotent / reload-safe
  if (existing !== undefined) {
    throw new Error(
      `Tool extension already registered for "${name}": ${existing} (refusing to overwrite with ${extensionPath})`,
    );
  }
  EXTRA_TOOL_EXTENSIONS.set(name, extensionPath);
}

// Expose registration on a process-global so project-local extensions loaded
// via jiti (separate module instances) can reach this shared map. Set at module
// load so it's available before any `session_start` listener runs.
(globalThis as any).__pi_interactive_subagents = {
  registerToolExtension,
};

/**
 * Helper to find the pi-web-access extension entry point with project-over-global precedence.
 */
function getWebAccessExtensionPath(startDir: string = process.cwd()): string | undefined {
  // 1. Search ancestor directories for project-local .pi/npm or node_modules
  let current = resolve(startDir);
  while (true) {
    const projectPiNpm = join(current, ".pi", "npm", "node_modules", "pi-web-access", "index.ts");
    if (existsSync(projectPiNpm)) return projectPiNpm;

    const projectNodeModules = join(current, "node_modules", "pi-web-access", "index.ts");
    if (existsSync(projectNodeModules)) return projectNodeModules;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // 2. Global agent config dir (~/.pi/agent/npm/node_modules/pi-web-access/index.ts)
  const globalPkg = join(getAgentConfigDir(), "npm", "node_modules", "pi-web-access", "index.ts");
  if (existsSync(globalPkg)) return globalPkg;

  return undefined;
}

/**
 * Map a custom (non-built-in) tool name to the pi-extension file that
 * registers it. Used to build the child's `--extension` whitelist after
 * `--no-extensions` disables global discovery. Returns undefined for built-in
 * tools and for unknown names (which are refused when building a sandbox).
 */
function getToolExtensionPath(tool: string, cwd?: string): string | undefined {
  if (BUILTIN_TOOLS.has(tool)) return undefined;
  const runtimePath = RUNTIME_TOOL_EXTENSIONS.get(tool);
  if (runtimePath && (runtimePath.startsWith("builtin:") || existsSync(runtimePath))) return runtimePath;
  if (UNRELOADABLE_RUNTIME_TOOLS.has(tool)) {
    const registered = EXTRA_TOOL_EXTENSIONS.get(tool);
    return registered && (registered.startsWith("builtin:") || existsSync(registered)) ? registered : undefined;
  }
  if (tool === "codemode") return "builtin:codemode";
  if (tool === "tool_search") return "builtin:tool-search";
  // The spawning tools are registered by THIS extension.
  if ((SPAWNING_TOOLS as readonly string[]).includes(tool)) {
    return fileURLToPath(import.meta.url);
  }
  const extBase = join(getAgentConfigDir(), "extensions");
  const webAccessPath = getWebAccessExtensionPath(cwd ?? process.cwd());
  const map: Record<string, string | undefined> = {
    web_enable: webAccessPath,
    web_search: webAccessPath ?? join(extBase, "web-search", "index.ts"),
    fetch_content: webAccessPath,
    get_search_content: webAccessPath,
    source_check: webAccessPath,
    web_fetch: join(extBase, "web-fetch", "index.ts"),
    video_extract: join(extBase, "video-extract", "index.ts"),
    youtube_search: join(extBase, "youtube-search", "index.ts"),
    google_image_search: join(extBase, "google-image-search", "index.ts"),
    safe_bash: join(SUBAGENTS_DIR, "tools", "safe-bash.ts"),
  };
  // Prefer the built-in path, but fall back to a runtime-registered extension
  // when that path no longer exists on disk (e.g. a built-in tool extension
  // was disabled/removed but a project-local extension re-registered it).
  const builtin = map[tool];
  if (builtin && existsSync(builtin)) return builtin;
  const registered = EXTRA_TOOL_EXTENSIONS.get(tool);
  return registered && (registered.startsWith("builtin:") || existsSync(registered)) ? registered : undefined;
}

/**
 * When this process was spawned as a restricted subagent, the parent pins the
 * set of agents it may itself spawn via PI_SUBAGENT_ALLOWED. An empty value
 * denies spawning; `null` means no restriction (top-level session).
 */
function getSubagentAllowlist(): Set<string> | null {
  const raw = process.env.PI_SUBAGENT_ALLOWED;
  if (raw === undefined) return null;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(list);
}

function getBundledAgentsDir(): string {
  return join(SUBAGENTS_DIR, "../../agents");
}

function getFrontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function parseMaxConcurrent(frontmatter: string, profileName: string): number | undefined {
  // Unlike permissive string fields, an explicitly empty limit is invalid too.
  const match = frontmatter.match(/^max-concurrent:[^\S\r\n]*([^\r\n]*)$/m);
  if (!match) return undefined;
  const raw = match[1].trim();
  const limit = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`Invalid max-concurrent in agent profile "${profileName}": must be a positive safe integer.`);
  }
  return limit;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value != null ? value === "true" : undefined;
}

/** Parse a comma-separated frontmatter value into a trimmed list (or undefined). */
function parseCommaList(value: string | undefined): string[] | undefined {
  if (value == null) return undefined;
  const list = value.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** Resolve Pi-only profile overrides, preserving empty selections and parent restrictions. */
function resolveEffectiveAgentLoadout(
  profile: AgentDefaults | null,
  override: AgentOverride | undefined,
  parentTools: readonly string[],
  parentAllowed: ReadonlySet<string> | null,
): { tools: string[]; skills: string[] | undefined; subagentAgents: string[]; modelFallback: string | null | undefined } {
  const requestedAgents = override?.subagentAgents ?? profile?.subagentAgents ?? [];
  return {
    tools: override?.tools ?? parseCommaList(profile?.tools) ?? [...parentTools],
    skills: override?.skills ?? parseCommaList(profile?.skills),
    subagentAgents: [...new Set(requestedAgents)].filter((name) => !parentAllowed || parentAllowed.has(name)),
    modelFallback: override?.modelFallback !== undefined ? override.modelFallback : profile?.modelFallback,
  };
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") {
    return value;
  }
  return undefined;
}

function parseAgentDefinition(content: string, fallbackName: string): AgentDefinition | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const frontmatter = match[1];
  const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
  const systemPromptMode = getFrontmatterValue(frontmatter, "system-prompt");
  let maxConcurrent: number | undefined;
  let maxConcurrentError: string | undefined;
  try { maxConcurrent = parseMaxConcurrent(frontmatter, fallbackName); }
  catch (error) { maxConcurrentError = error instanceof Error ? error.message : String(error); }

  return {
    name: getFrontmatterValue(frontmatter, "name") ?? fallbackName,
    maxConcurrent,
    maxConcurrentError,
    description: getFrontmatterValue(frontmatter, "description"),
    model: getFrontmatterValue(frontmatter, "model"),
    modelFallback: getFrontmatterValue(frontmatter, "model-fallback"),
    tools: getFrontmatterValue(frontmatter, "tools"),
    systemPromptMode:
      systemPromptMode === "replace"
        ? "replace"
        : systemPromptMode === "append"
          ? "append"
          : undefined,
    skills: getFrontmatterValue(frontmatter, "skill") ?? getFrontmatterValue(frontmatter, "skills"),
    thinking: getFrontmatterValue(frontmatter, "thinking"),
    subagentAgents: parseCommaList(getFrontmatterValue(frontmatter, "subagent_agents")),
    autoExit: parseOptionalBoolean(getFrontmatterValue(frontmatter, "auto-exit")),
    interactive: parseOptionalBoolean(getFrontmatterValue(frontmatter, "interactive")),
    sessionMode: parseSessionMode(getFrontmatterValue(frontmatter, "session-mode")),
    cwd: getFrontmatterValue(frontmatter, "cwd"),
    cli: getFrontmatterValue(frontmatter, "cli"),
    body: body || undefined,
    disableModelInvocation:
      getFrontmatterValue(frontmatter, "disable-model-invocation")?.toLowerCase() === "true",
  };
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  const agents = new Map<string, ListedAgentDefinition>();
  const dirs: Array<{ path: string; source: AgentSource }> = [
    { path: getBundledAgentsDir(), source: "package" },
    { path: join(getAgentConfigDir(), "agents"), source: "global" },
    { path: join(process.cwd(), ".pi", "agents"), source: "project" },
  ];

  for (const { path: dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((entry) => entry.endsWith(".md"))) {
      const parsed = parseAgentDefinition(
        readFileSync(join(dir, file), "utf8"),
        file.replace(/\.md$/, ""),
      );
      if (!parsed) continue;
      agents.set(parsed.name, { ...parsed, source });
    }
  }

  // When this process is itself a restricted subagent, only expose the agents
  // it is permitted to spawn (PI_SUBAGENT_ALLOWED). Top-level sessions see all.
  const all = [...agents.values()];
  const allowlist = getSubagentAllowlist();
  return allowlist ? all.filter((a) => allowlist.has(a.name)) : all;
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  return { effectiveCwd, localAgentDir };
}

function normalizeThinking(thinking: string | undefined): string | undefined {
  if (thinking === undefined) return undefined;
  const normalized = thinking.trim();
  if (!normalized) return undefined;
  const namedLevel = normalized.toLowerCase();
  if (namedLevel === "none") return "off";
  return NAMED_THINKING_LEVELS.has(namedLevel) ? namedLevel : normalized;
}

const STANDARD_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const NAMED_THINKING_LEVELS = new Set([
  ...STANDARD_THINKING_LEVELS,
  "none",
]);

/**
 * Split Pi's optional `:thinking` suffix without mistaking model-id colons
 * (for example Ollama's `llama3.1:8b`) for a reasoning level.
 */
function splitModelThinking(model: string | undefined): {
  model: string | undefined;
  thinking: string | undefined;
} {
  if (model === undefined) return { model: undefined, thinking: undefined };

  const lastColon = model.lastIndexOf(":");
  if (lastColon === -1) return { model, thinking: undefined };

  const suffix = model.slice(lastColon + 1).trim();
  const isNamedLevel = NAMED_THINKING_LEVELS.has(suffix.toLowerCase());
  const isTokenBudget = /^\d+$/.test(suffix);
  if (!isNamedLevel && !isTokenBudget) return { model, thinking: undefined };

  return {
    model: model.slice(0, lastColon),
    thinking: normalizeThinking(suffix),
  };
}

function getKnownModelsFromRegistry(): string[] {
  const modelIds = new Set<string>();
  if (latestCtx?.modelRegistry) {
    try {
      for (const m of latestCtx.modelRegistry.getAll()) {
        if (m.provider && m.id) {
          modelIds.add(`${m.provider}/${m.id}`);
        }
      }
    } catch {}
  }
  for (const agent of discoverAgentDefinitions()) {
    const model = splitModelThinking(agent.model).model?.trim();
    if (model) modelIds.add(model);
    if (agent.modelFallback?.toLowerCase() !== "inherit") {
      const fallback = splitModelThinking(agent.modelFallback).model?.trim();
      if (fallback) modelIds.add(fallback);
    }
  }
  const environmentModel = splitModelThinking(process.env.PI_MODEL).model?.trim();
  if (environmentModel) modelIds.add(environmentModel);

  return [...modelIds];
}

function getSupportedThinkingLevelsForModel(modelName: string | undefined): readonly string[] {
  if (!modelName || !latestCtx?.modelRegistry) return STANDARD_THINKING_LEVELS;
  try {
    const match = latestCtx.modelRegistry.getAll().find((m) =>
      `${m.provider}/${m.id}` === modelName || m.id === modelName
    );
    if (match && match.reasoning === false) {
      return ["off"];
    }
  } catch {}
  return STANDARD_THINKING_LEVELS;
}

/** Generate completions for `/subagent <agent>[@<model>][:<thinking>]`. */
function getSubagentArgumentCompletions(prefix: string) {
  // Once the first argument is followed by whitespace, the rest is the task.
  if (/\s/.test(prefix)) return null;

  const atIndex = prefix.indexOf("@");
  if (atIndex !== -1) {
    const agentName = prefix.slice(0, atIndex);
    const modelPart = prefix.slice(atIndex + 1);
    const colonIndex = modelPart.lastIndexOf(":");

    if (colonIndex !== -1) {
      const baseModel = modelPart.slice(0, colonIndex);
      const levelPrefix = modelPart.slice(colonIndex + 1).toLowerCase();
      const levels = getSupportedThinkingLevelsForModel(baseModel);
      return levels
        .filter((level) => level.startsWith(levelPrefix))
        .map((level) => {
          const value = `${agentName}@${baseModel}:${level}`;
          return { value, label: value };
        });
    }

    const models = getKnownModelsFromRegistry();
    return models
      .filter((model) => model.startsWith(modelPart))
      .map((model) => {
        const value = `${agentName}@${model}`;
        return { value, label: value };
      });
  }

  const colonIndex = prefix.indexOf(":");
  if (colonIndex !== -1) {
    const agentName = prefix.slice(0, colonIndex);
    const levelPrefix = prefix.slice(colonIndex + 1).toLowerCase();
    const agentDef = loadAgentDefaults(agentName);
    const agentModel = splitModelThinking(agentDef?.model).model?.trim();
    const levels = getSupportedThinkingLevelsForModel(agentModel);
    return levels
      .filter((level) => level.startsWith(levelPrefix))
      .map((level) => {
        const value = `${agentName}:${level}`;
        return { value, label: value };
      });
  }

  return discoverAgentDefinitions()
    .filter((agent) => agent.name.startsWith(prefix))
    .map((agent) => ({
      value: agent.name,
      label: agent.name,
      description: agent.description,
    }));
}

/** Parse `/subagent <agent>[@<model>][:<thinking>]`'s first argument. */
function parseSubagentSpec(spec: string): {
  agentName: string;
  model: string | undefined;
  thinking: string | undefined;
} {
  const trimmed = spec.trim();
  const atIndex = trimmed.indexOf("@");

  if (atIndex === -1) {
    const parsed = splitModelThinking(trimmed);
    return {
      agentName: parsed.model ?? "",
      model: undefined,
      thinking: parsed.thinking,
    };
  }

  const agentName = trimmed.slice(0, atIndex);
  const parsed = splitModelThinking(trimmed.slice(atIndex + 1));
  return {
    agentName,
    model: parsed.model?.trim() || undefined,
    thinking: parsed.thinking,
  };
}

/**
 * Resolve model and thinking together so the loadout always stores a bare model id.
 *
 * Precedence: explicit tool/`/subagent` args > `/subagent-settings` per-agent
 * override > agent markdown default.
 */
function resolveEffectiveModelAndThinking(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { model: string | undefined; thinking: string | undefined } {
  const pageOverride = params.agent ? configState.get().agents[params.agent] : undefined;
  const mergedDefs = agentDefs && pageOverride
    ? {
      ...agentDefs,
      ...(pageOverride.model !== undefined ? { model: pageOverride.model } : {}),
      ...(pageOverride.thinking !== undefined ? { thinking: pageOverride.thinking } : {}),
    }
    : (pageOverride
      ? {
        ...(pageOverride.model !== undefined ? { model: pageOverride.model } : {}),
        ...(pageOverride.thinking !== undefined ? { thinking: pageOverride.thinking } : {}),
      } as AgentDefaults
      : agentDefs);
  const resolvedModel = splitModelThinking(params.model ?? mergedDefs?.model);
  const thinking = params.thinking !== undefined
    ? normalizeThinking(params.thinking)
    : resolvedModel.thinking ?? normalizeThinking(mergedDefs?.thinking);

  return { model: resolvedModel.model, thinking };
}

interface ParentModelDefaults {
  model?: string;
  thinking?: string;
}

function resolveParentModelDefaults(ctx: ExtensionContext, pi: ExtensionAPI): ParentModelDefaults {
  const model = ctx.model?.provider && ctx.model.id
    ? `${ctx.model.provider}/${ctx.model.id}`
    : undefined;
  let thinking: string | undefined;
  try {
    thinking = normalizeThinking(pi.getThinkingLevel());
  } catch {}
  return { model, thinking };
}

/** Read the current fallback policy, preserving an explicitly disabled override. */
function resolveEffectiveModelFallback(agent: string, agentDefs: AgentDefaults | null): string | undefined {
  const override = agentDefs?.cli !== "claude" ? configState.get().agents[agent] : undefined;
  return (override?.modelFallback !== undefined
    ? override.modelFallback
    : agentDefs?.modelFallback)?.trim() || undefined;
}

/** Resolve one effective fallback. Undefined means no retry is configured. */
function resolveFallbackModelAndThinking(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
  parent: ParentModelDefaults,
): { model: string | undefined; thinking: string | undefined } | undefined {
  const rawFallback = resolveEffectiveModelFallback(params.agent, agentDefs);
  if (!rawFallback) return undefined;
  const fallbackModel = rawFallback.toLowerCase() === "inherit"
    ? { model: parent.model, thinking: undefined }
    : splitModelThinking(rawFallback);
  const primary = resolveEffectiveModelAndThinking(params, agentDefs);
  const thinking = primary.thinking ?? parent.thinking;
  return { model: fallbackModel.model, thinking: thinking ?? fallbackModel.thinking };
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

function buildSubagentTask(
  task: string,
  inheritsConversationContext: boolean,
  agentDefs: AgentDefaults | null,
): string {
  if (inheritsConversationContext) {
    return `Task dispatched to you by the orchestrator:\n\n${task}`;
  }

  const modeHint = agentDefs?.autoExit
    ? "Complete your task autonomously. When you are finished, simply stop — your session ends automatically."
    : "Complete your task. The user can interact with you at any time, and the session ends when the user exits the pane.";
  const summaryInstruction = agentDefs?.autoExit
    ? "Your FINAL assistant message should summarize what you accomplished."
    : "Your FINAL assistant message (before the user exits) should summarize what you accomplished.";
  const identity = agentDefs?.body ?? null;
  const identityInSystemPrompt = agentDefs?.systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  return `${roleBlock}\n\n${modeHint}\n\n${task}\n\n${summaryInstruction}`;
}

/**
 * Decide whether a subagent is interactive (user-driven, long-running).
 *
 * Resolution order:
 *   1. Explicit `interactive` frontmatter field on the agent.
 *   2. Default: the inverse of `auto-exit`. Agents that auto-exit are
 *      autonomous (scout, researcher) and the parent session should be
 *      woken on stall/recovery transitions. Agents that don't auto-exit are
 *      driven by the user in their own pane (worker) and stall pings are noise.
 */
function resolveEffectiveInteractive(
  _params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !(agentDefs?.autoExit ?? false);
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const configDir = getAgentConfigDir();
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(configDir, "agents", `${agentName}.md`),
    join(getBundledAgentsDir(), `${agentName}.md`),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    const parsed = parseAgentDefinition(readFileSync(p, "utf8"), agentName);
    if (parsed) return parsed;
  }

  return null;
}

function wrapCommandWithCompletion(command: string, completionFile: string, runId: string, ownerToken: string): string {
  const writer = [
    `import {recordCompletion,retrySessionOperation} from ${JSON.stringify(join(SUBAGENTS_DIR, "protocol.ts"))}`,
    'const [target,runId,ownerToken,rawCode]=process.argv.slice(1)',
    'await retrySessionOperation(()=>recordCompletion(target.slice(0,-9),{runId,ownerToken},Number(rawCode)))',
  ].join(";");
  const authorize = [
    `import {authorizeLaunch,retrySessionOperation} from ${JSON.stringify(join(SUBAGENTS_DIR, "protocol.ts"))}`,
    'const [target,runId,ownerToken]=process.argv.slice(1)',
    'await retrySessionOperation(()=>authorizeLaunch(target.slice(0,-9),{runId,ownerToken}))',
  ].join(";");
  return [
    "set +e",
    `node --input-type=module -e ${shellEscape(authorize)} ${shellEscape(completionFile)} ${shellEscape(runId)} ${shellEscape(ownerToken)}`,
    "__pi_authorized=$?",
    "if [ \"$__pi_authorized\" -ne 0 ]; then exit \"$__pi_authorized\"; fi",
    "__pi_subagent_signal=0",
    "trap '__pi_subagent_signal=1; kill -TERM \"$__pi_subagent_pid\" 2>/dev/null || true' TERM INT HUP",
    "exec 3<&0",
    `(${command}) <&3 3<&- &`,
    "__pi_subagent_pid=$!",
    "exec 3<&-",
    "wait \"$__pi_subagent_pid\"",
    "__pi_subagent_code=$?",
    "if [ \"$__pi_subagent_signal\" -eq 1 ]; then wait \"$__pi_subagent_pid\"; __pi_subagent_code=$?; fi",
    "trap '' TERM INT HUP",
    `node --input-type=module -e ${shellEscape(writer)} ${shellEscape(completionFile)} ${shellEscape(runId)} ${shellEscape(ownerToken)} "$__pi_subagent_code"`,
    "__pi_completion_code=$?",
    "if [ \"$__pi_completion_code\" -ne 0 ] && [ \"$__pi_subagent_code\" -eq 0 ]; then __pi_subagent_code=$__pi_completion_code; fi",
    "echo '__SUBAGENT_DONE_'$__pi_subagent_code'__'",
    "exit \"$__pi_subagent_code\"",
  ].join("\n");
}

function clearRunSignals(sessionFile: string): void {
  for (const suffix of [".exit", ".ask"]) rmSync(`${sessionFile}${suffix}`, { force: true });
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Compact token count: 850, 3.2k, 45k. */
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

/**
 * Known context-window sizes by model id substring, used for the context-usage
 * gauge. Unknown models fall back to a window-less "Nk ctx" label.
 */
function contextWindowFor(model: string | null | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("claude")) return 200_000;
  if (m.includes("gpt-5")) return 200_000;
  if (m.includes("gpt-4.1") || m.includes("gpt-4o")) return 128_000;
  if (m.includes("gemini")) return 1_000_000;
  return undefined;
}

/** Context-usage gauge: "18.0%/200k" when window known, else "37k ctx". */
function formatContextUsage(tokens: number, contextWindow: number | undefined): string {
  if (!contextWindow) return `${formatTokens(tokens)} ctx`;
  const pct = (tokens / contextWindow) * 100;
  const maxStr =
    contextWindow >= 1_000_000
      ? `${(contextWindow / 1_000_000).toFixed(1)}M`
      : `${Math.round(contextWindow / 1000)}k`;
  return `${pct.toFixed(1)}%/${maxStr}`;
}

/**
 * Build the dim usage line for a completed subagent, mirroring the format of
 * the in-process subagents extension: "↑in ↓out R… W… $cost · ctx".
 * `theme.fg` is applied by the caller; this returns plain segments joined.
 */
function formatUsageSegments(stats: SessionStats): string[] {
  const segs: string[] = [];
  if (stats.inputTokens) segs.push(`↑${formatTokens(stats.inputTokens)}`);
  if (stats.outputTokens) segs.push(`↓${formatTokens(stats.outputTokens)}`);
  if (stats.cacheReadTokens) segs.push(`R${formatTokens(stats.cacheReadTokens)}`);
  if (stats.cacheWriteTokens) segs.push(`W${formatTokens(stats.cacheWriteTokens)}`);
  if (stats.cost) segs.push(`$${stats.cost.toFixed(3)}`);
  return segs;
}

/** ANSI colors for widget status icons (raw, since the widget bypasses theme). */
const ICON_GREEN = "\x1b[38;2;126;186;103m";
const ICON_YELLOW = "\x1b[38;2;214;181;94m";
const ICON_RED = "\x1b[38;2;224;108;117m";
const ICON_DIM = "\x1b[38;2;128;128;128m";

type ThinkingTheme = {
  fg: Theme["fg"];
  getThinkingBorderColor(level: string): (text: string) => string;
};

function formatModelWithThinking(rawModel: string, thinkingOverride: string | undefined, theme: ThinkingTheme): string {
  const { model: baseModel, thinking: inlineThinking } = splitModelThinking(rawModel);
  const effectiveModel = (baseModel ?? rawModel).trim();
  const effectiveThinking = (thinkingOverride ?? inlineThinking)?.trim();
  // Foreground-only theme helpers preserve backgrounds supplied by transcript boxes.
  const model = theme.fg("dim", effectiveModel);
  if (!effectiveThinking || effectiveThinking.toLowerCase() === "off" || effectiveThinking.toLowerCase() === "none") {
    return model;
  }
  const normalized = effectiveThinking.toLowerCase();
  const label = `:${effectiveThinking}`;
  const colored = /^\d/.test(normalized)
    ? theme.fg("warning", label)
    : ["minimal", "low", "medium", "high", "xhigh", "max"].includes(normalized)
      ? theme.getThinkingBorderColor(normalized)(label)
      : theme.fg("dim", label);
  return model + colored;
}

/** Map a live status kind to a colored single-char icon for the widget. */
function widgetIcon(kind: StatusSnapshot["kind"]): string {
  switch (kind) {
    case "active":
    case "running":
      return `${ICON_YELLOW}⟳${RST}`;
    case "stalled":
      return `${ICON_RED}⟳${RST}`;
    case "waiting":
    case "starting":
    default:
      return `${ICON_DIM}○${RST}`;
  }
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require tmux. ${muxSetupHint()}`,
      },
    ],
    details: { error: "tmux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

/**
 * Unified live config state: status widget flag, backend preference, and
 * per-agent model/thinking overrides. `/subagent-settings` mutates it live
 * (persisting each change to the durable user agent config); spawn/resume resolution reads it.
 * The surface backend preference mirrors into surface.ts so live
 * createSurface() calls follow page changes without a restart.
 */
const configState: SubagentsConfigState = createSubagentsConfigState(loadSubagentsConfig());
setSurfaceBackendPreference(configState.get().multiplexing.backend);
const statusConfig = { get enabled() { return configState.get().status.enabled; }, lineLimit: DEFAULT_STATUS_LINE_LIMIT };

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: Pick<
    SubagentResult,
    "exitCode" | "elapsed" | "summary" | "sessionFile" | "sessionId" | "errorMessage" | "fallback" | "undeliveredMessages" | "ownershipError"
  >,
  name: string,
): string {
  // Name is the persistent handle: the same name steers a running subagent or
  // resumes a finished one, so follow-ups always reference it.
  const deliveryNote = result.undeliveredMessages?.length
    ? `\n\nUnacknowledged queued messages retained for explicit resume: ${result.undeliveredMessages.map((item) => `${item.messageId}${item.sessionFile ? ` (sessionPath: ${item.sessionFile})` : ""}`).join(", ")}.`
    : "";
  const ownershipNote = result.ownershipError ? `\n\n${result.ownershipError}` : "";
  const sessionRef = `${deliveryNote}${ownershipNote}\n\nFollow up with subagent_message({ name: "${name}", message: "…" })`;
  const fallbackNote = result.fallback
    ? `Primary model${result.fallback.primaryModel ? ` ${result.fallback.primaryModel}` : ""} failed (${result.fallback.reason}); retried with ${result.fallback.fallbackModel}.\n\n`
    : "";

  if (result.errorMessage) {
    // Auto-retry exhausted or other agent-loop error. The subagent did not
    // produce a usable result — surface the underlying provider/network
    // failure so the orchestrator can decide whether to retry, resume, or
    // change approach instead of silently treating the run as completed.
    return (
      fallbackNote +
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error — auto-retry exhausted).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      (result.summary ? `${result.summary}\n\n` : "") +
      `Any available child output is preserved above. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_message.${sessionRef}`
    );
  }

  return fallbackNote + (result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`);
}

type InterruptionActor =
  | { kind: "main_agent" }
  | { kind: "parent_subagent"; id: string; name?: string; agent?: string };

interface InterruptionMetadata {
  actor: InterruptionActor;
  requestedAt: number;
}

/** Capture the caller identity from runtime state, never model-supplied tool arguments. */
function captureInterruptionActor(env: NodeJS.ProcessEnv = process.env): InterruptionActor {
  const id = env.PI_SUBAGENT_ID?.trim();
  if (!id) return { kind: "main_agent" };
  const name = env.PI_SUBAGENT_NAME?.trim();
  const agent = env.PI_SUBAGENT_AGENT?.trim();
  return { kind: "parent_subagent", id, ...(name ? { name } : {}), ...(agent ? { agent } : {}) };
}

/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  /** Canonical session header id, used for follow-ups via subagent_message. */
  sessionId?: string;
  claudeSessionId?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
  undeliveredMessages?: InboxMessage[];
  ownershipError?: string;
  /** True when the orchestration caller cancelled the run with `subagent_interrupt`. */
  interrupted?: boolean;
  interruption?: InterruptionMetadata;
  /** Provider/agent error message when auto-retry exhausted (overload, rate limit, etc.). */
  errorMessage?: string;
  /** Whether this run produced any non-whitespace assistant text. */
  hasAssistantText?: boolean;
  /** Aggregate usage/model/tool stats parsed from the completed session file. */
  stats?: SessionStats;
  /** Present when this is the result of a one-shot model fallback retry. */
  fallback?: {
    primaryModel?: string;
    fallbackModel: string;
    reason: string;
    failedSessionFile?: string;
  };
}

function shouldRetryWithFallback(result: SubagentResult): { retry: boolean; reason?: string } {
  if (result.error === "cancelled" || result.interrupted) return { retry: false };
  if (result.errorMessage) return { retry: true, reason: result.errorMessage };
  if (result.exitCode !== 0) return { retry: true, reason: `exit code ${result.exitCode}` };
  if (result.hasAssistantText === false) return { retry: true, reason: "no assistant response text" };
  return { retry: false };
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  /** Unique invocation identity; changes on every resume of a session file. */
  runId: string;
  ownerToken?: string;
  /** Parent identity captured before launch, independent of later session switches. */
  parentIdentity?: string;
  name: string;
  task: string;
  agent?: string;
  surface: string;
  startTime: number;
  sessionFile: string;
  launchScriptFile?: string;
  logFile?: string;
  activityFile?: string;
  activity?: SubagentActivityState;
  activityRead?: {
    ok: boolean;
    reason?: "missing" | "invalid" | "wrong-id";
    error?: string;
  };
  abortController?: AbortController;
  cli?: string;
  sentinelFile?: string;
  /**
   * Captured when the orchestration caller cancels with `subagent_interrupt`. The pane is
   * being torn down: hide the widget entry, ignore status transitions and
   * pending questions, skip model fallback, and steer a concise interruption
   * notice instead of the full completion result.
   */
  interruption?: InterruptionMetadata;
  statusState: SubagentStatusState;
  /**
   * When true, status transitions (stalled/recovered) do not wake the parent
   * session via a steer message. The widget still updates locally. Used for
   * long-running agents where the user drives the conversation in the
   * subagent's pane (e.g. planner).
   */
  interactive: boolean;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();

// When this extension is loaded inside a subagent that itself spawns children
// (e.g. a worker delegating to scout/researcher), `subagent-done.ts` runs in the
// same process and needs to know whether this session still has children in
// flight — so it can suppress auto-exit and keep the session open until they all
// report back. Expose a live count through a process-global symbol that both
// modules share. (subagent-done.ts reads it; if absent it assumes zero.)
const RUNNING_CHILDREN_COUNT_KEY = Symbol.for("pi-subagents/running-children-count");
(globalThis as any)[RUNNING_CHILDREN_COUNT_KEY] = () => reservedNames.size +
  Array.from(runningSubagents.values()).filter((r) =>
    !reservedNames.has(nameReservationKey(r.name, r.parentIdentity))).length;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;
/** Latest ExtensionAPI, used to deliver ask_question notifications from the watcher. */
let latestPi: ExtensionAPI | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function formatWidgetTelemetryClusters(stats: {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}): string[] {
  const clusters: string[] = [];

  let io = "";
  if (stats.inputTokens) io += `↑${formatTokens(stats.inputTokens)}`;
  if (stats.outputTokens) io += `↓${formatTokens(stats.outputTokens)}`;
  if (io) clusters.push(io);

  let cache = "";
  if (stats.cacheReadTokens) cache += `R${formatTokens(stats.cacheReadTokens)}`;
  if (stats.cacheWriteTokens) cache += `W${formatTokens(stats.cacheWriteTokens)}`;
  if (cache) clusters.push(cache);

  if (stats.cost) clusters.push(`$${stats.cost.toFixed(3)}`);

  return clusters;
}

function formatWidgetTelemetryLine(
  snapshot: StatusSnapshot,
  theme: ThinkingTheme,
): { left: string; right: string } | null {
  const hasTelemetry = [
    snapshot.model,
    snapshot.inputTokens,
    snapshot.outputTokens,
    snapshot.cacheReadTokens,
    snapshot.cacheWriteTokens,
    snapshot.contextTokens,
    snapshot.cost,
  ].some((value) => value != null);
  if (!hasTelemetry) return null;

  const usageClusters = formatWidgetTelemetryClusters({
    inputTokens: snapshot.inputTokens ?? 0,
    outputTokens: snapshot.outputTokens ?? 0,
    cacheReadTokens: snapshot.cacheReadTokens ?? 0,
    cacheWriteTokens: snapshot.cacheWriteTokens ?? 0,
    cost: snapshot.cost ?? 0,
  });
  const telemetryText = usageClusters.length > 0
    ? `↳ ${usageClusters.join("  ")}`
    : "↳ starting…";
  const left = `          ${ICON_DIM}${telemetryText}${RST} `;

  const rightSegments: string[] = [];
  if (snapshot.model) {
    rightSegments.push(formatModelWithThinking(snapshot.model, snapshot.thinking, theme));
  }
  if (snapshot.contextTokens != null && snapshot.contextTokens > 0) {
    const baseModel = splitModelThinking(snapshot.model).model ?? snapshot.model;
    const contextWindow = contextWindowFor(baseModel);
    const contextText = formatContextUsage(snapshot.contextTokens, contextWindow);
    const percent = contextWindow ? (snapshot.contextTokens / contextWindow) * 100 : null;
    const color = percent == null
      ? ICON_DIM
      : percent > 80
        ? ICON_RED
        : percent >= 50
          ? ICON_YELLOW
          : ICON_GREEN;
    rightSegments.push(`${color}${contextText}${RST}`);
  }
  const right = rightSegments.length > 0
    ? ` ${rightSegments.join(`${ICON_DIM} · ${RST}`)} `
    : "";

  return { left, right };
}

function renderSubagentWidgetLines(
  agents: RunningSubagent[],
  width: number,
  theme: ThinkingTheme & Pick<Theme, "fg" | "bold">,
): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.startTime);
    const identity = formatSubagentIdentity(agent.name, agent.agent, theme);
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const icon = widgetIcon(snapshot.kind);
    const left = ` ${icon} ${elapsed}  ${identity} `;
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.cli === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));

    const telemetryLine = formatWidgetTelemetryLine(snapshot, theme);
    if (telemetryLine) lines.push(borderLine(telemetryLine.left, telemetryLine.right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  const visible = visibleRunningSubagents();
  if (visible.length === 0) {
    if (latestCtx?.hasUI) latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  if (!latestCtx?.hasUI) return;

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui, theme) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(visibleRunningSubagents(), width, theme);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["ask_question"] as const;

/**
 * Build the child --tools allowlist.
 *
 * Pi 0.70+ applies --tools to built-in, extension, and custom tools. If a
 * subagent definition restricts tools to e.g. "read,bash,write", the child
 * control tools from subagent-done.ts would otherwise be hidden, leaving a
 * manually resumed or user-touched subagent unable to call ask_question.
 */
function buildSubagentToolAllowlist(
  effectiveTools?: string | readonly string[],
  opts?: { grantSpawning?: boolean },
): string | null {
  const requested = (typeof effectiveTools === "string" ? effectiveTools.split(",") : effectiveTools ?? [])
    .map((tool) => tool.trim())
    .filter(Boolean);

  const grantSpawning = opts?.grantSpawning ?? false;

  // An absent historical selection remains unrestricted on replay. New Pi
  // launches always supply an array, including [] for no optional tools.
  if (!Array.isArray(effectiveTools) && requested.length === 0 && !grantSpawning) return null;

  // Listing a spawning tool never grants delegation by itself.
  const allow = new Set(requested.filter((tool) => !(SPAWNING_TOOLS as readonly string[]).includes(tool)));
  if (grantSpawning) {
    for (const tool of SPAWNING_TOOLS) allow.add(tool);
  }
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

/**
 * Apply a loadout snapshot's sandbox to a pi command's `parts` array: model,
 * identity (system prompt), and the default-deny tool/extension restriction
 * (`--no-extensions` + `--tools` + one `-e` per tool-backing extension).
 *
 * This is the single source of truth for reconstructing a subagent's sandbox,
 * used both by the initial `launchSubagent` and by the `subagent_message`
 * resume path so the two can never drift. Env vars (PI_SUBAGENT_AGENT /
 * PI_SUBAGENT_ALLOWED / PI_CODING_AGENT_DIR) and cwd are the caller's
 * responsibility since they differ slightly between launch and resume.
 */
function applySandboxToParts(
  parts: string[],
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string },
): void {
  if (loadout.toolAllowlist) validateShellSelection(loadout.toolAllowlist.split(","));
  if (hasBash(loadout.toolAllowlist)) {
    if (!loadout.bashGuardExtensionPath) {
      throw new Error("Cannot launch bash-enabled subagent: its loadout has no pinned bash-guard source. Start a new subagent with bash-guard installed, or select safe_bash.");
    }
    const guardPath = validateBashGuardExtension(loadout.bashGuardExtensionPath);
    // Load the guard before subagent-done: its startup readiness check must run after guard initialization.
    parts.splice(1, 0, "-e", shellEscape(guardPath));
    // Pi otherwise resolves/installs configured packages even with --no-extensions.
    parts.push("--offline");
  }
  if (loadout.model) {
    const model = loadout.thinking ? `${loadout.model}:${loadout.thinking}` : loadout.model;
    parts.push("--model", shellEscape(model));
  }

  if (loadout.identity) {
    const flag = loadout.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const spPath = join(opts.artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(spPath), { recursive: true });
    writeFileSync(spPath, loadout.identity, "utf8");
    parts.push(flag, shellEscape(spPath));
  }

  // Default-deny: disable global extension discovery and re-enable only the
  // extensions backing the whitelisted tools. A null allowlist means the spawn
  // belongs to an existing intentionally-unrestricted snapshot, replayed as-is.
  if (loadout.toolAllowlist) {
    parts.push("--no-extensions");
    parts.push("--tools", shellEscape(loadout.toolAllowlist));

    // New snapshots pin backing sources, not just tool names: a fresh parent
    // can replay custom tools even when it has not loaded their extensions.
    const extPaths = loadout.toolExtensionPaths ?? snapshotToolExtensionPaths(
      loadout.toolAllowlist.split(","), loadout.cwd ?? process.cwd(),
    );
    for (const extPath of new Set(extPaths)) {
      if (!extPath.startsWith("builtin:") && !existsSync(extPath)) {
        throw new Error(`Cannot replay subagent tool extension "${extPath}": the recorded source is unavailable.`);
      }
      parts.push("-e", shellEscape(extPath));
    }
  }
}

/**
 * Build the `pi --session` command for resuming a recorded session: the
 * session file, the always-loaded subagent-done extension, the model /
 * identity / default-deny sandbox replayed from the spawn-time loadout
 * snapshot, and the follow-up prompt as an @file. Split out of the resume
 * tool handler so tests can pin the replay wiring without spawning a real
 * surface.
 */
function buildResumeCommandParts(
  sessionPath: string,
  loadout: SubagentLoadout,
  opts: { artifactDir: string; name: string; message?: string },
): { parts: string[]; resumeMsgFile?: string } {
  if (loadout.cli === "claude") throw new Error(CLAUDE_MESSAGE_ERROR);
  const parts = ["pi", "--session", shellEscape(sessionPath)];

  // Load subagent-done extension so the agent can self-terminate if needed
  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  // Replay the model, identity, and default-deny tool/extension sandbox.
  applySandboxToParts(parts, loadout, { artifactDir: opts.artifactDir, name: opts.name });

  let resumeMsgFile: string | undefined;
  if (opts.message) {
    const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    resumeMsgFile = join(
      opts.artifactDir,
      "subagent-resume",
      `${opts.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
    );
    mkdirSync(dirname(resumeMsgFile), { recursive: true });
    writeFileSync(resumeMsgFile, opts.message, "utf8");
    parts.push(shellEscape(`@${resumeMsgFile}`));
  }

  return { parts, resumeMsgFile };
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string | readonly string[];
  taskDelivery: "direct" | "artifact";
  taskArg: string;
}): string[] {
  const skillPrompts = (typeof params.effectiveSkills === "string" ? params.effectiveSkills.split(",") : params.effectiveSkills ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = params.taskDelivery === "artifact" && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    params.taskArg,
  ];
}

function isThinkingEventType(type?: string): boolean {
  if (!type) return false;
  return type === "thinking" || type === "thinking_start" || type === "thinking_delta";
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") {
    if (isThinkingEventType(activity.messageEventType)) return "thinking";
    return "streaming";
  }
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.cli === "claude") return;

  const activityFile = running.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
      model: read.activity.model,
      thinking: read.activity.thinking,
      inputTokens: read.activity.inputTokens,
      outputTokens: read.activity.outputTokens,
      cacheReadTokens: read.activity.cacheReadTokens,
      cacheWriteTokens: read.activity.cacheWriteTokens,
      contextTokens: read.activity.contextTokens,
      cost: read.activity.cost,
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

/**
 * Parent-scoped names held from synchronous launch reservation through watcher
 * finalization, including fallback startup. Persistent registry entries keep
 * completed handles unique after these transient reservations are released.
 */
const reservedNames = new Set<string>();
// Count every admission, including unlimited profiles, so live policy reductions
// see existing startup/active/fallback runs. This is parent policy, not sandbox state.
const profileAdmissions = new Map<string, Map<string | null, number>>();

function getProfileAdmissionCount(parentIdentity: string, profile: string | null): number {
  return profileAdmissions.get(parentIdentity)?.get(profile) ?? 0;
}

function reserveProfileAdmission(parentIdentity: string, profile: string | null, defaults: AgentDefaults | null): () => void {
  if (defaults?.maxConcurrentError) throw new Error(defaults.maxConcurrentError);
  // Backend-neutral: Claude launches use the parent's saved limit overrides too.
  const override = profile === null ? undefined : configState.get().agents[profile]?.maxConcurrent;
  const limit = override === undefined ? defaults?.maxConcurrent : override;
  const count = getProfileAdmissionCount(parentIdentity, profile);
  if (limit != null && count >= limit) {
    throw new Error(`This parent session already has ${count} admitted run(s) of the "${profile}" profile (maxConcurrent: ${limit}). Wait for completion before starting or resuming another.`);
  }
  const counts = profileAdmissions.get(parentIdentity) ?? new Map<string | null, number>();
  counts.set(profile, count + 1);
  profileAdmissions.set(parentIdentity, counts);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (counts.get(profile) ?? 0) - 1;
    if (remaining > 0) counts.set(profile, remaining);
    else counts.delete(profile);
    if (counts.size === 0 && profileAdmissions.get(parentIdentity) === counts) profileAdmissions.delete(parentIdentity);
  };
}
interface SessionReservation {
  name: string;
  parentIdentity: string;
  started: Promise<RunningSubagent>;
  resolve: (running: RunningSubagent) => void;
  reject: (error: unknown) => void;
  owner?: SessionOwner;
}
const sessionReservations = new Map<string, SessionReservation>();

function captureParent(ctx: ExtensionContext) {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionDir = ctx.sessionManager.getSessionDir();
  const sessionId = ctx.sessionManager.getSessionId();
  const leafId = ctx.sessionManager.getLeafId();
  const artifactDir = getArtifactDir(sessionDir, sessionId);
  const identity = canonicalSessionPath(sessionFile ?? artifactDir);
  // The manager is mutable across awaits/session switches. Keep only plain launch data.
  return { identity, artifactDir, leafId, sessionFile, sessionDir, sessionId, cwd: ctx.cwd };
}

function nameReservationKey(name: string, parentIdentity?: string): string {
  return parentIdentity ? `${parentIdentity}\0${name}` : name;
}

function reserveSession(sessionFile: string, name: string, parentIdentity: string): SessionReservation {
  let resolve!: SessionReservation["resolve"];
  let reject!: SessionReservation["reject"];
  const started = new Promise<RunningSubagent>((yes, no) => { resolve = yes; reject = no; });
  // A failed launch may have no joiners; still let every joiner observe its rejection.
  void started.catch(() => {});
  const reservation = { name, parentIdentity, started, resolve, reject };
  const key = canonicalSessionPath(sessionFile);
  if (sessionReservations.has(key)) throw new Error(`Session "${sessionFile}" already has an active writer reservation.`);
  sessionReservations.set(key, reservation);
  return reservation;
}

function lifecycleError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text }], details: { error: text } };
}

async function joinStartingSession(reservation: SessionReservation, message: string) {
  try {
    const running = await reservation.started;
    if (runningSubagents.get(running.id) !== running) {
      return lifecycleError(`Subagent "${running.name}" is finalizing; retry after its completion notice.`);
    }
    return handleSubagentSteer({ name: running.name, message }, undefined, running);
  } catch (error) {
    return lifecycleError(`Subagent "${reservation.name}" startup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Injectable launch boundaries keep concurrency regression tests deterministic without child processes.
const lifecycle = { launchSubagent, watchSubagent, createSurface, sendLongCommand, closeSurface };

/**
 * Return `base`, or `base-2`, `base-3`, … so the result is unique within this
 * spawner session. Considers (a) currently-running subagents, (b) names
 * reserved by parallel in-flight spawns, and (c) every name already recorded in
 * the spawner's persistent registry — so a defaulted name never collides with a
 * finished subagent either. This lets `subagent_message({ name })` address any
 * subagent of this session unambiguously, running or finished.
 *
 * `registryNames` is the set of names already taken in the registry (empty when
 * there is no session file / artifact dir yet).
 */
function uniqueRunningName(base: string, registryNames?: Set<string>, parentIdentity?: string): string {
  const taken = new Set(Array.from(runningSubagents.values())
    .filter((r) => !parentIdentity || r.parentIdentity === parentIdentity)
    .map((r) => r.name));
  for (const reserved of reservedNames) {
    const prefix = parentIdentity ? `${parentIdentity}\0` : "";
    if (!parentIdentity || reserved.startsWith(prefix)) taken.add(reserved.slice(prefix.length));
  }
  if (registryNames) for (const n of registryNames) taken.add(n);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Resolve the display name for a path-addressed resume (`sessionPath`).
 * Reclaims the registry name when this session file is already known to the
 * current spawner session; otherwise derives a name from the filename and
 * uniquifies it against running agents and the registry, so the resumed run
 * still registers without clobbering an unrelated entry.
 */
function reclaimNameForSessionPath(artifactDir: string, sessionFile: string, parentIdentity?: string): string {
  const registry = readNameRegistry(artifactDir);
  for (const [registeredName, entry] of Object.entries(registry)) {
    if (
      entry &&
      typeof entry.sessionFile === "string" &&
      canonicalSessionPath(entry.sessionFile) === canonicalSessionPath(sessionFile)
    ) {
      return registeredName;
    }
  }
  const base = basename(sessionFile, ".jsonl").trim() || "resume";
  return uniqueRunningName(base, new Set(Object.keys(registry)), parentIdentity);
}

function resolveRunningByName(name: string, parentIdentity?: string):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedName = name.trim();
  if (!requestedName) {
    return { error: "Provide the exact display name of a running subagent." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.name === requestedName &&
    (!parentIdentity || running.parentIdentity === parentIdentity));
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    const names = Array.from(runningSubagents.values()).map((r) => r.name);
    const hint = names.length
      ? ` Currently running: ${[...new Set(names)].join(", ")}.`
      : " No subagents are currently running.";
    return { error: `No running subagent named "${requestedName}".${hint}` };
  }

  const candidates = matches.map((running) => `${running.name} [${running.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

/** Running subagents that should still appear in the widget. Interrupted runs stay in the map until their watcher observes the torn-down surface and removes them. */
function visibleRunningSubagents(): RunningSubagent[] {
  return Array.from(runningSubagents.values()).filter((running) => !running.interruption);
}

function runningTargetHint(): string {
  const targets = [
    ...new Map(
      Array.from(runningSubagents.values()).map((running) => [running.id, `${running.name} [${running.id}]`] as const),
    ).values(),
  ];
  return targets.length
    ? ` Currently running: ${targets.join(", ")}.`
    : " No subagents are currently running.";
}

function resolveRunningForInterrupt(params: { id?: unknown; name?: unknown }, parentIdentity?: string):
  | { running: RunningSubagent }
  | { error: string } {
  const id = typeof params.id === "string" ? params.id.trim() : "";
  const name = typeof params.name === "string" ? params.name.trim() : "";
  if (!id && !name) {
    return { error: "Provide the running subagent's `id` or `name`." };
  }

  let running: RunningSubagent | undefined;
  if (id) {
    running = runningSubagents.get(id);
    if (!running || (parentIdentity && running.parentIdentity !== parentIdentity)) {
      return { error: `No running subagent with id "${id}" in this parent session.${runningTargetHint()}` };
    }
  }
  if (name) {
    const resolved = resolveRunningByName(name, parentIdentity);
    if ("error" in resolved) return { error: resolved.error };
    if (running && resolved.running !== running) {
      return { error: `Subagent id "${id}" does not match subagent name "${name}".` };
    }
    running = resolved.running;
  }
  return { running: running as RunningSubagent };
}

function formatInterruptedNotice(name: string, elapsed: number, actor?: InterruptionActor): string {
  const attribution = actor?.kind === "main_agent"
    ? " by the main agent"
    : actor?.kind === "parent_subagent"
      ? ` by parent subagent "${actor.name ?? actor.agent ?? actor.id}"`
      : "";
  return `Sub-agent "${name}" was interrupted${attribution} after ${formatElapsed(elapsed)}. It did not produce a result.`;
}

/**
 * Deliver the concise interruption notice for a cancelled run. Returns true
 * when the caller should skip the normal completion path (full result,
 * fallback retry, and pending questions) entirely.
 */
function finalizeInterruptedRun(
  pi: ExtensionAPI,
  running: RunningSubagent,
  result: Pick<SubagentResult, "elapsed" | "exitCode" | "interrupted" | "interruption" | "undeliveredMessages" | "ownershipError"> & { sessionId?: string },
): boolean {
  const interruption = running.interruption ?? result.interruption;
  if (!interruption && !result.interrupted) return false;
  updateWidget();
  pi.sendMessage(
    {
      customType: "subagent_result",
      content: formatInterruptedNotice(running.name, result.elapsed, interruption?.actor) +
        (result.undeliveredMessages?.length ? ` Unacknowledged messages retained: ${result.undeliveredMessages.map((item) => `${item.messageId}${item.sessionFile ? ` (sessionPath: ${item.sessionFile})` : ""}`).join(", ")}.` : "") +
        (result.ownershipError ? ` ${result.ownershipError}` : ""),
      display: true,
      details: {
        name: running.name,
        task: running.task,
        agent: running.agent,
        exitCode: result.exitCode,
        elapsed: result.elapsed,
        sessionFile: running.sessionFile,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        interrupted: true,
        ...(result.undeliveredMessages ? { undeliveredMessages: result.undeliveredMessages } : {}),
        ...(result.ownershipError ? { ownershipError: result.ownershipError } : {}),
        ...(interruption ? { interruption } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
  return true;
}

/** Publish an immutable message under the same session mutex used for closure and writer ownership. */
function enqueueSteerMessage(sessionFile: string, message: string, runId: string, ownerToken: string): InboxMessage {
  return enqueueMessage(sessionFile, { runId, ownerToken }, message);
}

async function steerSubagent(
  running: RunningSubagent,
  message: string,
  send?: (surface: string, command: string, options?: { sessionFile?: string }) => void,
): Promise<{ ok: true; messageId?: string } | { error: string }> {
  if (running.cli === "claude") return { error: CLAUDE_MESSAGE_ERROR };
  const body = message;
  let messageId: string | undefined;
  try {
    // Pi consumes orchestration input through a sidecar queue. Sending the
    // same text as terminal keys would submit every steer twice.
    if (send) await send(running.surface, body);
    else {
      if (!running.ownerToken) throw new Error("Unknown session owner; reload the parent extension before using managed messaging.");
      messageId = enqueueSteerMessage(running.sessionFile, body, running.runId, running.ownerToken).messageId;
    }
    return { ok: true, ...(messageId ? { messageId } : {}) };
  } catch (error: any) {
    return {
      error:
        `Failed to deliver message to subagent "${running.name}": ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

async function handleSubagentSteer(
  params: { name?: string; message?: string },
  send?: (surface: string, command: string) => void,
  target?: RunningSubagent,
) {
  const message = params.message;
  if (!message?.trim()) {
    const err = "`message` is required to steer a running subagent.";
    return { content: [{ type: "text" as const, text: err }], details: { error: err } };
  }

  const resolved = target ? { running: target } : resolveRunningByName(params.name ?? "");
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.interruption) {
    const err = `Subagent "${running.name}" was interrupted and is shutting down; it cannot receive new messages.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name },
    };
  }
  const now = Date.now();
  observeRunningSubagent(running, now);

  const steer = await steerSubagent(running, message, send);
  if ("error" in steer) {
    return {
      content: [{ type: "text" as const, text: steer.error }],
      details: { error: steer.error, id: running.id, name: running.name },
    };
  }

  // Acceptance does not mean the child has ingested the message or changed activity.
  updateWidget();

  return {
    content: [{
      type: "text" as const,
      text:
        `Message queued for subagent "${running.name}". This confirms acceptance, not ingestion. ` +
        `If the child exits before consuming it, the message is retained for explicit resume.`,
    }],
    details: {
      id: running.id,
      name: running.name,
      ...(running.agent ? { agent: running.agent } : {}),
      status: "queued",
      ...(steer.messageId ? { messageId: steer.messageId } : {}),
    },
  };
}

/**
 * Cancel a running Pi-backed subagent. The runtime caller's interruption is recorded
 * before touching the surface so the watcher suppresses the normal completion
 * result, fallback retry, status transitions, and pending questions. Escape
 * (or SIGINT headless) cancels the in-flight turn; closing the surface
 * guarantees the child process is gone. If teardown fails, the marker is
 * reverted so a still-live run keeps its normal completion path.
 */
async function handleSubagentInterrupt(
  params: { id?: unknown; name?: unknown },
  actor: InterruptionActor,
  interrupt: (surface: string) => Promise<void> = interruptSurface,
  close: (surface: string) => Promise<void> = closeSurface,
  parentIdentity?: string,
) {
  const resolved = resolveRunningForInterrupt(params, parentIdentity);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.cli === "claude") {
    const err = `Subagent "${running.name}" runs via the Claude Code CLI and cannot be interrupted from here. Close its pane manually.`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name, ...(running.agent ? { agent: running.agent } : {}) },
    };
  }
  if (running.interruption) {
    return {
      content: [{
        type: "text" as const,
        text: `Interrupt already requested for subagent "${running.name}". Its pane is shutting down; the watcher will confirm removal.`,
      }],
      details: { id: running.id, name: running.name, ...(running.agent ? { agent: running.agent } : {}), status: "interrupt_already_requested" },
    };
  }

  const now = Date.now();
  const previousInterruption = running.interruption;
  const previousStatusState = running.statusState;
  running.interruption = { actor, requestedAt: now };
  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  try {
    await interrupt(running.surface);
    await close(running.surface);
  } catch (error: any) {
    running.interruption = previousInterruption;
    running.statusState = previousStatusState;
    updateWidget();
    const message = error?.message ?? String(error);
    const err = `Failed to interrupt subagent "${running.name}": ${message}`;
    return {
      content: [{ type: "text" as const, text: err }],
      details: { error: err, id: running.id, name: running.name, ...(running.agent ? { agent: running.agent } : {}), status: "interrupt_failed" },
    };
  }

  return {
    content: [{
      type: "text" as const,
      text:
        `Interrupt requested for subagent "${running.name}". Its turn was cancelled and its pane closed. ` +
        `The watcher will confirm removal and steer a concise interruption notice; no result will follow.`,
    }],
    details: { id: running.id, name: running.name, ...(running.agent ? { agent: running.agent } : {}), status: "interrupt_requested" },
  };
}

/**
 * One status-supervision pass over the running set: refresh snapshots, advance
 * status kinds, and steer stalled/recovered transitions for non-interactive
 * runs. Split out of the refresh interval so tests can drive it with a fixed
 * clock instead of real timers.
 */
function runStatusSupervisionTick(pi: ExtensionAPI, now: number): void {
    const transitionLines: string[] = [];
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      if (running.interruption) continue;
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // Interactive subagents (long-running, user-driven) intentionally don't
      // wake the parent session on stalled/recovered transitions — the user is
      // working in the subagent's pane, and a steer message here would burn an
      // orchestrator turn on a no-op "still waiting" ping. Widget still updates.
      if (transition && !running.interactive) {
        transitionLines.push(formatTransitionLine(running.name, snapshot, transition, running.agent));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    runStatusSupervisionTick(pi, Date.now());
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

// Resuming a finished session is always autonomous: the relaunched agent runs
// its follow-up task to completion and the harness delivers the result as a
// steer message (fire-and-forget). An interactive resume would park the pane
// waiting for the user, contradicting that result-delivery model.
function resolveResumeLaunchBehavior(): { autoExit: boolean; interactive: boolean } {
  return { autoExit: true, interactive: false };
}

export const __test__ = {
  SubagentActionOutputSchema,
  SubagentListOutputSchema,
  addStructuredSubagentResult,
  listStructuredAgents,
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  getSubagentArgumentCompletions,
  getKnownModelsFromRegistry,
  getSupportedThinkingLevelsForModel,
  setTestContext: (ctx: any) => {
    latestCtx = ctx;
  },
  parseSubagentSpec,
  resolveEffectiveModelAndThinking,
  resolveEffectiveAgentLoadout,
  getSubagentAllowlist,
  captureRuntimeToolExtensions,
  clearToolExtensions: () => {
    EXTRA_TOOL_EXTENSIONS.clear();
    RUNTIME_TOOL_EXTENSIONS.clear();
    UNRELOADABLE_RUNTIME_TOOLS.clear();
  },
  getSubagentToolCatalog,
  getSubagentSkillCatalog,
  validateSubagentTools,
  snapshotToolExtensionPaths,
  getSubagentsConfigState: () => configState,
  launchSubagent,
  resolveParentModelDefaults,
  resolveFallbackModelAndThinking,
  shouldRetryWithFallback,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  applySandboxToParts,
  buildPiPromptArgs,
  buildSubagentTask,
  formatWidgetRightLabel,
  observeRunningSubagent,
  getToolExtensionPath,
  resolveRunningByName,
  uniqueRunningName,
  reclaimNameForSessionPath,
  reservedNames,
  profileAdmissions,
  getProfileAdmissionCount,
  reserveProfileAdmission,
  parseAgentDefinition,
  sessionReservations,
  canonicalSessionPath,
  lifecycle,
  enqueueSteerMessage,
  steerSubagent,
  handleSubagentSteer,
  handleSubagentInterrupt,
  captureInterruptionActor,
  resolveRunningForInterrupt,
  formatInterruptedNotice,
  finalizeInterruptedRun,
  visibleRunningSubagents,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  buildResumeCommandParts,
  runStatusSupervisionTick,
  runningSubagents,
  formatElapsed,
  formatTokens,
  formatContextUsage,
  contextWindowFor,
  formatUsageSegments,
  formatWidgetTelemetryClusters,
  formatWidgetTelemetryLine,
  formatModelWithThinking,
  activityLabel,
  widgetIcon,
  wrapCommandWithCompletion,
  clearRunSignals,
};

function startWidgetRefresh() {
  if (!latestCtx?.hasUI || widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: ExtensionContext,
  options?: { surface?: string; parentLeafId?: string | null; piTools?: readonly string[]; ownedSessions?: string[]; parent?: ReturnType<typeof captureParent> },
): Promise<RunningSubagent> {
  const parent = options?.parent ?? captureParent(ctx);
  const parentIdentity = parent.identity;
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);
  const runId = `${id}-${Math.random().toString(16).slice(2, 10)}`;

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  // Display name is optional in the tool params; default to the agent's own name.
  const displayName = params.name ?? params.agent ?? "subagent";
  const { model: effectiveModel, thinking: effectiveThinking } =
    resolveEffectiveModelAndThinking(params, agentDefs);
  const piLoadout = agentDefs?.cli === "claude" ? undefined : resolveEffectiveAgentLoadout(
    agentDefs,
    configState.get().agents[params.agent],
    options?.piTools ?? [],
    getSubagentAllowlist(),
  );
  const effectiveTools = piLoadout?.tools;
  const effectiveSkills = piLoadout?.skills;
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);

  const { sessionFile, sessionId, artifactDir } = parent;
  if (!sessionFile) throw new Error("No session file");

  const { effectiveCwd, localAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? parent.cwd;
  const resolvedAgentDir =
    localAgentDir && existsSync(localAgentDir)
      ? localAgentDir
      : process.env.PI_CODING_AGENT_DIR ?? null;
  const grantSpawning = !!piLoadout?.subagentAgents.length;
  const toolAllowlist = piLoadout ? buildSubagentToolAllowlist(effectiveTools, { grantSpawning }) : null;
  const toolExtensionPaths = toolAllowlist
    ? snapshotToolExtensionPaths(toolAllowlist.split(","), targetCwdForSession)
    : [];
  const bashGuardExtensionPath = hasBash(toolAllowlist)
    ? await resolveBashGuardExtension(targetCwdForSession, resolvedAgentDir ?? getAgentConfigDir())
    : undefined;

  // Generate a deterministic session file path for this subagent scoped inside
  // the parent session's artifact directory (artifacts/<parentSessionId>/subagents/).
  // This scopes the subagent session to its parent and keeps ~/.pi/agent/sessions/--<cwd>--/ clean of child clusters.
  writeArtifactOwnershipMarker(artifactDir, sessionId);
  const subagentSessionDir = getSubagentSessionDir(artifactDir);
  mkdirSync(subagentSessionDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(subagentSessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const safeLogName = (params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent";
  const logFile = join(artifactDir, "subagent-logs", `${safeLogName}-${id}.log`);
  const sessionKey = canonicalSessionPath(subagentSessionFile);
  const reservation = options?.ownedSessions ? reserveSession(subagentSessionFile, displayName, parentIdentity) : undefined;
  if (reservation) options!.ownedSessions!.push(sessionKey);
  let owner: SessionOwner;
  try {
    owner = claimSession(subagentSessionFile, runId, true);
    if (reservation) reservation.owner = owner;
  } catch (error) {
    reservation?.reject(error);
    if (reservation) sessionReservations.delete(sessionKey);
    throw error;
  }
  let commandAttempted = false;
  const previousRegistration = reservation ? resolveNameInRegistry(artifactDir, displayName) : null;
  let registered = false;
  const persistName = () => {
    if (!reservation) return;
    registerName(artifactDir, displayName, { sessionFile: subagentSessionFile, sessionId: getSessionId(subagentSessionFile) });
    registered = true;
  };
  let surface: string | undefined;
  try {
  surface = options?.surface ?? await lifecycle.createSurface(displayName, {
    id,
    logPath: logFile,
    sessionFile: subagentSessionFile,
  });
  if (!surfacePreCreated && getSurfaceBackend(surface) === "tmux") {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  const launchBehavior = resolveLaunchBehavior(params, agentDefs);

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      parentLeafId: options?.parentLeafId !== undefined
        ? options.parentLeafId
        : parent.leafId,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  // Build the task message
  // Only full-context fork mode inherits prior conversation state.
  // Blank-session modes need the wrapper instructions and artifact-backed handoff.
  // An agent with a non-empty effective spawnable list is granted the spawning
  // toolset, bounded by its parent's restriction (enforced via PI_SUBAGENT_ALLOWED).
  const identity = agentDefs?.body ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const fullTask = buildSubagentTask(params.task, inheritsConversationContext, agentDefs);
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const sentinelFile = `/tmp/pi-claude-${id}-done`;
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_CLAUDE_SENTINEL=${shellEscape(sentinelFile)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";
    clearRunSignals(subagentSessionFile);
    const command = wrapCommandWithCompletion(`${cdPrefix}exec env ${cmdParts.join(" ")}`, `${subagentSessionFile}.complete`, runId, owner.ownerToken);

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    writeSubagentLoadout(subagentSessionFile, {
      cli: "claude", agent: params.agent, toolAllowlist: null,
      model: effectiveModel ?? null, thinking: effectiveThinking ?? null,
      systemPromptMode: agentDefs.systemPromptMode ?? null, identity: agentDefs.body ?? null,
      spawnable: null, autoExit: agentDefs.autoExit ?? false, cwd: effectiveCwd,
      agentDir: localAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? null,
    });
    persistName();
    commandAttempted = true;
    await lifecycle.sendLongCommand(surface, command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running: RunningSubagent = {
      id,
      runId,
      parentIdentity,
      ownerToken: owner.ownerToken,
      name: displayName,
      task: params.task,
      agent: params.agent,
      surface,
      startTime,
      sessionFile: subagentSessionFile,
      launchScriptFile,
      logFile: getBackgroundSurfaceLogPath(surface),
      cli: "claude",
      sentinelFile,
      interactive: effectiveInteractive,
      statusState: createStatusState({
        source: "claude",
        startTimeMs: startTime,
      }),
    };

    runningSubagents.set(id, running);
    reservation?.resolve(running);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  // New Pi launches always pin optional tools plus the managed controls.
  // An absent profile selection inherits the parent's active optional tools.

  // Snapshot the fully-resolved sandbox beside the session file so a later
  // `subagent_message({ name })` resume can replay the exact same
  // restriction instead of relaunching pi with all global extensions + tools.
  const loadout: SubagentLoadout = {
    cli: "pi",
    agent: params.agent ?? null,
    toolAllowlist,
    toolExtensionPaths,
    ...(bashGuardExtensionPath ? { bashGuardExtensionPath } : {}),
    model: effectiveModel ?? null,
    thinking: effectiveThinking ?? null,
    systemPromptMode: systemPromptMode ?? null,
    identity: identityInSystemPrompt ? identity : null,
    spawnable: piLoadout!.subagentAgents,
    autoExit: agentDefs?.autoExit ?? false,
    cwd: effectiveCwd ?? null,
    agentDir: resolvedAgentDir,
  };
  writeSubagentLoadout(subagentSessionFile, loadout);

  // Apply model, identity, and the default-deny tool/extension restriction via
  // the shared helper (same code path resume uses — they can't drift).
  applySandboxToParts(parts, loadout, { artifactDir, name: displayName });

  // Build env prefix: subagent identity + config dir propagation + spawn allowlist
  const envParts: string[] = [];
  if (hasBash(toolAllowlist)) envParts.push("PI_BASH_GUARD_APPROVAL_MODE=deny");

  if (resolvedAgentDir) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resolvedAgentDir)}`);
  }

  // Explicit empty denies delegation rather than inheriting a wider parent env.
  envParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(piLoadout!.subagentAgents.join(","))}`);
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(displayName)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  if (agentDefs?.autoExit) {
    envParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
  }
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_RUN_ID=${shellEscape(runId)}`);
  envParts.push(`PI_SUBAGENT_OWNER_TOKEN=${shellEscape(owner.ownerToken)}`);
  envParts.push(`PI_SUBAGENT_BACKEND=${shellEscape(getSurfaceBackend(surface))}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = displayName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  clearRunSignals(subagentSessionFile);
  const piCommand = cdPrefix + "exec env " + envPrefix + parts.join(" ");
  const command = wrapCommandWithCompletion(piCommand, `${subagentSessionFile}.complete`, runId, owner.ownerToken);
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  persistName();
  commandAttempted = true;
  await lifecycle.sendLongCommand(surface, command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running: RunningSubagent = {
    id,
    runId,
    parentIdentity,
    ownerToken: owner.ownerToken,
    name: displayName,
    task: params.task,
    agent: params.agent,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    launchScriptFile,
    logFile: getBackgroundSurfaceLogPath(surface),
    activityFile,
    interactive: effectiveInteractive,
    statusState: createStatusState({
      source: "pi",
      startTimeMs: startTime,
      model: effectiveModel,
      thinking: effectiveThinking,
    }),
  };

  runningSubagents.set(id, running);
  reservation?.resolve(running);
  return running;
  } catch (error) {
    reservation?.reject(error);
    // Once a split/process surface has been allocated, every setup failure must
    // tear down exactly that owned surface. closeSurface is idempotent.
    let cleanupError: unknown;
    if (surface) { try { await lifecycle.closeSurface(surface); } catch (failure) { cleanupError = failure; } }
    let safe = false;
    try {
      if (!commandAttempted) { abandonStartingSession(subagentSessionFile, owner); safe = true; }
      else safe = finalizeSession(subagentSessionFile, owner);
    } catch (failure) { cleanupError ??= failure; }
    if (safe && reservation) sessionReservations.delete(sessionKey);
    if (registered && safe) restoreNameRegistration(artifactDir, displayName, subagentSessionFile, previousRegistration);
    const failure = new Error(`${error instanceof Error ? error.message : String(error)}${cleanupError ? `; cleanup failed: ${String(cleanupError)}` : ""}${safe ? "" : "; writer termination is unproven; ownership retained and further launches refused"}`);
    (failure as any).unsafeOwnership = !safe;
    throw failure;
  }
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface,
 * and removes the entry from runningSubagents.
 */
const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function copyClaudeSession(sentinelFile: string): string | null {
  try {
    const transcriptFile = sentinelFile + ".transcript";
    if (!existsSync(transcriptFile)) return null;
    const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;
    mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
    const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
    const dest = join(CLAUDE_SESSIONS_DIR, filename);
    copyFileSync(transcriptPath, dest);
    return filename;
  } catch {
    return null;
  }
}

/**
 * Detect an `ask_question` signal from a still-running subagent and notify the
 * orchestrator without ending the subagent. Each subagent has its own
 * `${sessionFile}.ask` file and its own watcher, so parallel questions from
 * multiple subagents are delivered independently. The file is deleted after
 * delivery so it fires once per question (a subagent may ask again later).
 */
function deliverPendingQuestion(running: RunningSubagent): void {
  const askFile = `${running.sessionFile}.ask`;
  let payload: any = null;
  try {
    if (!existsSync(askFile)) return;
    payload = JSON.parse(readFileSync(askFile, "utf-8"));
  } catch {
    // Malformed/partway-written file — drop it and move on.
  }
  try {
    unlinkSync(askFile);
  } catch {}
  if (!payload?.question) return;
  if (payload.runId !== undefined && payload.runId !== running.runId) return;
  if (payload.createdAt !== undefined && (!Number.isFinite(payload.createdAt) || payload.createdAt < running.startTime)) return;

  const name = running.name; // unique per session (deduped at spawn) — targets the reply
  const sessionId = existsSync(running.sessionFile) ? getSessionId(running.sessionFile) : null;
  const elapsed = Math.floor((Date.now() - running.startTime) / 1000);
  const replyHint = `\n\nReply with subagent_message({ name: "${name}", message: "…" }) — the same name works whether it is still running or has since exited. It stays open until you reply.`;

  latestPi?.sendMessage(
    {
      customType: "subagent_question",
      content: `Sub-agent "${name}" asks (${formatElapsed(elapsed)}):\n\n${payload.question}${replyHint}`,
      display: true,
      details: {
        name,
        agent: running.agent,
        question: payload.question,
        ...(sessionId ? { sessionId } : {}),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

async function watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult> {
  const result = await watchSubagentRun(running, signal);
  try {
    const pending = pendingMessages(running.sessionFile);
    if (pending.length) result.undeliveredMessages = pending;
    if (!running.ownerToken || !finalizeSession(running.sessionFile, { ownerToken: running.ownerToken, runId: running.runId })) {
      result.ownershipError = "Writer termination is unproven: no matching wrapper completion. Ownership retained; further launches are refused.";
    }
  } catch (error) { result.ownershipError = `Cannot finalize session ownership: ${String(error)}`; }
  return result;
}

function releaseFinalizedReservations(keys: readonly string[]): boolean {
  let safe = true;
  for (const key of keys) {
    const reservation = sessionReservations.get(key);
    if (!reservation) continue;
    try {
      if (reservation.owner && !finalizeSession(key, reservation.owner)) { safe = false; continue; }
      if (sessionReservations.get(key) === reservation) sessionReservations.delete(key);
    } catch { safe = false; }
  }
  return safe;
}

async function watchSubagentRun(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile } = running;

  try {
    const result = await pollForExit(surface, AbortSignal.any([signal, getModuleAbortSignal()]), {
      interval: 1000,
      sessionFile,
      sentinelFile: running.sentinelFile,
      runId: running.runId,
      ownerToken: running.ownerToken,
      startedAt: running.startTime,
      onTick() {
        observeRunningSubagent(running);
        if (!running.interruption) deliverPendingQuestion(running);
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    if (running.cli === "claude") {
      // Claude Code result extraction
      let summary = "";

      if (running.sentinelFile) {
        try {
          summary = readFileSync(running.sentinelFile, "utf-8").trim();
        } catch {}
      }

      if (!summary) {
        summary = (await readScreen(surface, 200))
          .replace(/__SUBAGENT_DONE_\d+__/, "")
          .trimEnd();
      }

      if (!summary) {
        summary = result.exitCode !== 0
          ? `Claude Code exited with code ${result.exitCode}`
          : "Claude Code exited without output";
      }

      // Copy Claude session transcript
      let sessionId: string | null = null;
      if (running.sentinelFile) {
        sessionId = copyClaudeSession(running.sentinelFile);
        try { unlinkSync(running.sentinelFile); } catch {}
        try { unlinkSync(running.sentinelFile + ".transcript"); } catch {}
      }

      await closeSurface(surface);
      runningSubagents.delete(running.id);

      return {
        name,
        task,
        summary,
        exitCode: result.exitCode,
        elapsed,
        hasAssistantText: summary.trim().length > 0,
        interrupted: !!running.interruption,
        ...(running.interruption ? { interruption: running.interruption } : {}),
        ...(sessionId ? { claudeSessionId: sessionId } : {}),
      };
    }

    // Pi subagent result extraction
    let summary: string;
    let hasAssistantText = false;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      hasAssistantText = allEntries.some((entry: any) =>
        entry?.type === "message" &&
        entry?.message?.role === "assistant" &&
        Array.isArray(entry.message.content) &&
        entry.message.content.some(
          (block: any) => block?.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
        )
      );
      summary =
        findLastAssistantMessage(allEntries) ??
        (result.errorMessage
          ? `Subagent error: ${result.errorMessage}`
          : result.exitCode !== 0
            ? `Sub-agent exited with code ${result.exitCode}`
            : "Sub-agent exited without output");
    } else {
      summary = result.errorMessage
        ? `Subagent error: ${result.errorMessage}`
        : result.exitCode !== 0
          ? `Sub-agent exited with code ${result.exitCode}`
          : "Sub-agent exited without output";
    }

    const stats = existsSync(sessionFile) ? summarizeSessionStats(sessionFile) : null;
    const subagentSessionId = existsSync(sessionFile) ? getSessionId(sessionFile) : null;

    await closeSurface(surface);
    runningSubagents.delete(running.id);

    return {
      name,
      task,
      summary,
      sessionFile,
      ...(subagentSessionId ? { sessionId: subagentSessionId } : {}),
      exitCode: result.exitCode,
      elapsed,
      ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
      hasAssistantText,
      interrupted: !!running.interruption,
      ...(running.interruption ? { interruption: running.interruption } : {}),
      ...(stats ? { stats } : {}),
    };
  } catch (err: any) {
    try {
      await closeSurface(surface);
    } catch {}
    runningSubagents.delete(running.id);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
        interrupted: !!running.interruption,
        ...(running.interruption ? { interruption: running.interruption } : {}),
        sessionFile,
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
      interrupted: !!running.interruption,
      ...(running.interruption ? { interruption: running.interruption } : {}),
    };
  }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  latestPi = pi;
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
    // pi runs multiple sessions in one process. A prior session's shutdown
    // aborts the shared module poll-abort controller; install a fresh one so
    // subagents spawned in this session aren't watched against a dead signal.
    // See https://github.com/HazAT/pi-interactive-subagents/issues/5
    const prevAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (!prevAbort || prevAbort.signal.aborted) {
      (globalThis as any)[POLL_ABORT_KEY] = new AbortController();
    }

  });

  // Clean up on session shutdown
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
      (globalThis as any)[STATUS_INTERVAL_KEY] = null;
    }
    const moduleAbort = (globalThis as any)[POLL_ABORT_KEY] as AbortController | undefined;
    if (moduleAbort) moduleAbort.abort();
    const agents = [...runningSubagents.values()];
    for (const agent of agents) agent.abortController?.abort();
    // Pi awaits async session_shutdown hooks. Abort watchers before attempting
    // bounded backend cleanup, and settle every owned surface independently.
    await Promise.allSettled(agents.map(async (agent) => {
      try { await closeSurface(agent.surface); } catch {}
    }));
    await closeAllBackgroundSurfaces();
    runningSubagents.clear();
  });

  // The spawning tools are always registered here. Whether a child process can
  // actually see/use them is governed by the parent's `--tools` allowlist and
  // by which extensions are loaded into the child (default-deny --no-extensions
  // + explicit -e). See launchSubagent().

  // ── subagent tool ──
  pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      promptSnippet:
        "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT call subagents_list or any other tool to 'check' status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate, assume, or summarize results after calling this tool. " +
        "After spawning, either end your turn immediately, or work on other independent tasks (including spawning more subagents in parallel). The harness will wake you with the result when it is ready.",
      parameters: SubagentParams,
      outputSchema: SubagentActionOutputSchema,

      execute: withSubagentStructuredOutput<typeof SubagentParams>(async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Strict whitelist at every depth. The caller's permitted set is:
        //   • a restricted subagent (PI_SUBAGENT_ALLOWED) → only its pinned agents;
        //   • a top-level session → every discoverable agent, i.e. exactly what
        //     `subagents_list` shows.
        // Every spawn must name a discoverable agent in that set; unknown or
        // missing roles cannot bypass the profile sandbox.
        const allowlist = getSubagentAllowlist();
        const permittedAgents = discoverAgentDefinitions().map((a) => a.name);
        const permittedSet = new Set(permittedAgents);
        const permittedList = permittedAgents.join(", ") || "(none)";

        if (!params.agent) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You must specify which agent to spawn via the "agent" field. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: { error: "agent required" },
          };
        } else if (!permittedSet.has(params.agent)) {
          return {
            content: [
              {
                type: "text",
                text:
                  `You may not spawn the "${params.agent}" agent — it is not ` +
                  `${allowlist ? "in your allowlist" : "a known agent"}. ` +
                  `Available agents: ${permittedList}.`,
              },
            ],
            details: {
              error: allowlist ? "agent not in allowlist" : "unknown agent",
            },
          };
        }

        // Validate prerequisites (need mux + a session file to derive the
        // artifact dir that hosts this session's name registry).
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        const agentDefs = loadAgentDefaults(params.agent);
        const parentDefaults = resolveParentModelDefaults(ctx, pi);
        const primarySelection = resolveEffectiveModelAndThinking(params, agentDefs);
        const fallbackSelection = resolveFallbackModelAndThinking(params, agentDefs, parentDefaults);
        if (agentDefs?.cli !== "claude") captureRuntimeToolExtensions(pi);
        const piTools = agentDefs?.cli === "claude" ? undefined : pi.getActiveTools();

        // This spawner session's artifact dir hosts its persistent name
        // registry (artifacts/<parentSessionId>/subagent-registry.json).
        const parent = captureParent(ctx);
        const parentArtifactDir = parent.artifactDir;

        // Default the persistent name to the agent name when omitted,
        // disambiguating against running subagents, in-flight reservations, and
        // every name already in the registry — so names stay unique across the
        // whole session, running or finished. Reserve the chosen name
        // synchronously (before any await) so parallel spawns don't collide.
        const registryNames = new Set(Object.keys(readNameRegistry(parentArtifactDir)));
        const explicitName = params.name?.trim();
        params.name = explicitName || uniqueRunningName(params.agent, registryNames, parent.identity);
        const reservedName = nameReservationKey(params.name, parent.identity);
        if (explicitName && (registryNames.has(explicitName) || reservedNames.has(reservedName) ||
            Array.from(runningSubagents.values()).some((r) => r.parentIdentity === parent.identity && r.name === explicitName))) {
          return lifecycleError(`Subagent name "${explicitName}" is already taken in this parent session. Choose a new name or use subagent_message.`);
        }
        let releaseAdmission: () => void;
        try { releaseAdmission = reserveProfileAdmission(parent.identity, params.agent, agentDefs); }
        catch (error) { return lifecycleError(error); }
        reservedNames.add(reservedName);
        const release = () => {
          reservedNames.delete(reservedName);
          releaseAdmission();
        };
        const spawnParentLeafId = parent.leafId;
        const ownedSessions: string[] = [];
        const trackSession = (run: RunningSubagent) => {
          run.parentIdentity = parent.identity;
          const key = canonicalSessionPath(run.sessionFile);
          const reservation = sessionReservations.get(key) ?? reserveSession(run.sessionFile, run.name, parent.identity);
          reservation.resolve(run);
          if (!ownedSessions.includes(key)) ownedSessions.push(key);
        };

        let running: RunningSubagent | undefined;
        try {
          running = await lifecycle.launchSubagent(params, ctx, { parent, parentLeafId: spawnParentLeafId, piTools, ownedSessions });
          trackSession(running);
        } catch (error) {
          if (running) {
            try { await lifecycle.closeSurface(running.surface); } catch {}
            runningSubagents.delete(running.id);
          }
          if (!(error as any)?.unsafeOwnership) {
            for (const key of ownedSessions) sessionReservations.delete(key);
            release();
          }
          return lifecycleError(`Subagent startup failed: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Create a separate AbortController for the watcher
        // (the tool's signal completes when we return)
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Start widget refresh and status supervision when the first agent launches
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget: start watching in background. A configured model
        // fallback gets one fresh retry from the original task; failed-session
        // artifacts remain available for diagnosis.
        lifecycle.watchSubagent(running, watcherAbort.signal)
          .then(async (primaryResult) => {
            let finalRunning = running;
            let result = primaryResult;
            // A parent-cancelled run never retries or reports a normal result.
            if (finalizeInterruptedRun(pi, running, primaryResult)) return;
            const retryDecision = shouldRetryWithFallback(primaryResult);
            const fallbackDiffers = !!fallbackSelection && (
              fallbackSelection.model !== primarySelection.model ||
              normalizeThinking(fallbackSelection.thinking) !== normalizeThinking(primarySelection.thinking)
            );

            if (!primaryResult.ownershipError && retryDecision.retry && fallbackSelection && fallbackDiffers) {
              const fallback = {
                primaryModel: primarySelection.model,
                fallbackModel: fallbackSelection.model ?? "(pi default)",
                reason: retryDecision.reason ?? "primary run failed",
                failedSessionFile: primaryResult.sessionFile,
              };
              const retryParams = {
                ...params,
                name: running.name,
                model: fallbackSelection.model,
                thinking: fallbackSelection.thinking,
              };
              try {
                finalRunning = await lifecycle.launchSubagent(retryParams, ctx, { parent, parentLeafId: spawnParentLeafId, piTools, ownedSessions });
                trackSession(finalRunning);
                finalRunning.abortController = watcherAbort;
                startWidgetRefresh();
                startStatusRefresh(pi);
                result = await lifecycle.watchSubagent(finalRunning, watcherAbort.signal);
                const retained = [...(primaryResult.undeliveredMessages ?? []), ...(result.undeliveredMessages ?? [])];
                if (retained.length) result.undeliveredMessages = retained;
                result.fallback = fallback;
              } catch (error: any) {
                if (finalRunning !== running && runningSubagents.has(finalRunning.id)) {
                  try { await lifecycle.closeSurface(finalRunning.surface); } catch {}
                  runningSubagents.delete(finalRunning.id);
                }
                result = {
                  ...primaryResult,
                  exitCode: 1,
                  errorMessage: `Fallback launch failed: ${error?.message ?? String(error)}`,
                  fallback,
                };
              }
            }

            updateWidget(); // reflect removal from Map immediately

            // Registry identity was saved before launch. Resume resolves a missing header id from the session file.
            const presentation = resolveResultPresentation(result, finalRunning.name);

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name: finalRunning.name,
                  task: finalRunning.task,
                  agent: finalRunning.agent,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: result.sessionFile,
                  ...(result.sessionId ? { sessionId: result.sessionId } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.claudeSessionId ? { claudeSessionId: result.claudeSessionId } : {}),
                  ...(result.stats ? { stats: result.stats } : {}),
                  ...(result.fallback ? { fallback: result.fallback } : {}),
                  ...(result.undeliveredMessages ? { undeliveredMessages: result.undeliveredMessages } : {}),
                  ...(result.ownershipError ? { ownershipError: result.ownershipError } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name: running.name, task: running.task, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .finally(() => {
            if (releaseFinalizedReservations(ownedSessions)) release();
          });

        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                `Do NOT generate or assume any results — you have no idea what the sub-agent will do or produce. ` +
                `The results will be delivered to you automatically as a steer message when the sub-agent finishes. ` +
                `Until then, move on to other work or tell the user you're waiting.`,
            },
          ],
          details: {
            id: running.id,
            name: params.name,
            task: params.task,
            agent: params.agent,
            sessionFile: running.sessionFile,
            launchScriptFile: running.launchScriptFile,
            ...(running.logFile ? { logFile: running.logFile } : {}),
            status: "started",
          },
        };
      }),

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const agentName =
          typeof partialArgs.agent === "string" && partialArgs.agent ? partialArgs.agent : "";
        const name =
          typeof partialArgs.name === "string" && partialArgs.name
            ? partialArgs.name
            : agentName || "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const identity = formatSubagentIdentity(name, agentName, theme);
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "○ " +
          theme.fg("dim", "subagent · ") +
          identity +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";
        const agent = typeof details?.agent === "string" ? details.agent : "";
        const identity = formatSubagentIdentity(name, agent, theme);

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("dim", "subagent · ") +
              identity +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const first = result.content[0];
        const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
  pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Cancel a running Pi-backed subagent by exact `id` or `name`. " +
        "This cancels its in-flight turn, terminates its child process, and closes its pane. " +
        "The watcher then steers a concise interruption notice instead of a result. " +
        "Use for a runaway or obsolete subagent. Claude Code CLI children cannot be interrupted.",
      promptSnippet:
        "Cancel a running Pi-backed subagent by exact id or name. Terminates the child process and closes its pane; " +
        "the watcher steers a concise interruption notice instead of a result.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      outputSchema: SubagentActionOutputSchema,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<any> {
        const actor = captureInterruptionActor();
        return addStructuredSubagentResult(await handleSubagentInterrupt(params, actor, interruptSurface, closeSurface, captureParent(ctx).identity));
      },

      renderCall(args, theme) {
        const partialArgs = args as { id?: unknown; name?: unknown };
        const id = typeof partialArgs.id === "string" && partialArgs.id ? partialArgs.id : "";
        const nameArg = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "";
        // Resolve by id (exact map key) when present, else by name; display the
        // stable name handle rather than a cryptic per-launch id.
        const running = id
          ? runningSubagents.get(id)
          : Array.from(runningSubagents.values()).find((r) => r.name === nameArg);
        const target = running?.name ?? (id || nameArg || "(unknown)");
        const agent = running?.agent;
        const identity = formatSubagentIdentity(target, agent, theme);
        return new Text(
          "○ " + theme.fg("dim", "subagent · ") + identity + theme.fg("dim", " — interrupt"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        // Render recorded identity so completed runs stay stable after removal or resume.
        const name = details?.name ?? details?.id ?? "subagent";
        const agent = typeof details?.agent === "string" ? details.agent : "";
        const identity = formatSubagentIdentity(name, agent, theme);
        const channel = theme.fg("dim", "subagent · ");
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("warning", "!") +
              " " +
              channel +
              identity +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }
        if (details?.status === "interrupt_already_requested") {
          return new Text(
            theme.fg("warning", "!") +
              " " +
              channel +
              identity +
              theme.fg("dim", " — interrupt already requested"),
            0,
            0,
          );
        }

        const first = result.content[0];
        const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
  pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List available subagents with effective model, thinking, and fallback defaults for new spawns (including settings overrides). " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      promptSnippet:
        "List available subagents with effective model, thinking, and fallback defaults for new spawns (including settings overrides). " +
        "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
        "Project-local agents override global ones with the same name.",
      parameters: Type.Object({}),
      outputSchema: SubagentListOutputSchema,

      async execute() {
        const overrides = configState.get().agents;
        const list = discoverAgentDefinitions().filter((agent) =>
          !(overrides[agent.name]?.disableModelInvocation ?? agent.disableModelInvocation))
          .map((agent) => ({
            ...agent,
            ...resolveEffectiveModelAndThinking({ agent: agent.name, task: "" }, agent),
            modelFallback: resolveEffectiveModelFallback(agent.name, agent),
          }));

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: "No subagent definitions found." }],
            details: { agents: [] },
            structuredContent: listStructuredAgents(list),
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const fallback = a.modelFallback ? ` → ${a.modelFallback}` : "";
          const selection = [a.model, a.thinking ? `thinking: ${a.thinking}` : undefined].filter(Boolean).join("; ");
          const model = selection || fallback ? ` [${selection}${fallback}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
          structuredContent: listStructuredAgents(list),
        };
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const fallback = a.modelFallback ? ` → ${a.modelFallback}` : "";
          const selection = [a.model, a.thinking ? `thinking: ${a.thinking}` : undefined].filter(Boolean).join("; ");
          const model = selection || fallback ? theme.fg("dim", ` [${selection}${fallback}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_message tool ──
  pi.registerTool({
      name: "subagent_message",
      label: "Message Subagent",
      description:
        "Send a message to a subagent by name, or resume a recorded session file by path. Names are unique within your session and persist after a subagent finishes, " +
        "so the SAME name works whether the subagent is running or finished: if it is still running, your message steers its live session; " +
        "if it has finished, your message resumes that session and continues it. " +
        "Pass `sessionPath` instead of `name` to reach recorded Pi sessions missing from this registry. Finished-session resume requires the original loadout, current ownership metadata, and matching post-exit wrapper completion. Unknown or foreign active ownership is refused. Claude CLI messaging and message-based resume are unsupported. " +
        "`message` is always required; provide exactly one of `name` or `sessionPath`. " +
        "Queueing to a running subagent returns a local queued acknowledgement, not an ingestion receipt, and does NOT by itself emit a new result. " +
        "Resuming is a fire-and-forget async call: when the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up. " +
        "DO NOT poll, sleep, tail logs, or read session files to detect completion — the harness handles delivery. " +
        "DO NOT fabricate or assume results. After calling, either end your turn or work on other independent tasks.",
      promptSnippet:
        "Message a subagent by name (steers it if running, resumes it if finished), or resume a recorded session file via `sessionPath` when the name is not in this session's registry. " +
        "`message` is required; provide exactly one of `name` or `sessionPath`. Queueing returns immediately without claiming ingestion; closed delivery rejects late input so retry with explicit resume after completion. Resuming delivers its result later as a steer message. " +
        "Claude CLI messaging is unsupported; finished-session resume requires the loadout and matching ownership/completion evidence. " +
        "Do not poll or fabricate results.",
      parameters: SubagentMessageParams,

      renderCall(args, theme) {
        const target = args.name ?? (args.sessionPath ? basename(args.sessionPath) : "(unknown)");
        const running = typeof args.name === "string" && args.name
          ? Array.from(runningSubagents.values()).find((r) => r.name === args.name)
          : undefined;
        const identity = formatSubagentIdentity(target, running?.agent, theme);
        return new Text(
          "○ " + theme.fg("dim", "subagent · ") + identity + theme.fg("dim", " — message"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? (details?.status === "started" ? "Resume" : "subagent");
        const agent = typeof details?.agent === "string" ? details.agent : "";
        const identity = formatSubagentIdentity(name, agent, theme);

        if (details?.status === "queued") {
          return new Text(
            theme.fg("success", "✓") +
              " " +
              theme.fg("dim", "subagent · ") +
              identity +
              theme.fg("dim", " — message queued"),
            0,
            0,
          );
        }

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "⟳") +
              " " +
              theme.fg("dim", "subagent · ") +
              identity +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback / error
        const first = result.content[0];
        const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      outputSchema: SubagentActionOutputSchema,

      execute: withSubagentStructuredOutput<typeof SubagentMessageParams>(async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        const requestedName = params.name?.trim() || undefined;
        const requestedSessionPath = params.sessionPath?.trim() || undefined;
        if (requestedName && requestedSessionPath) {
          const err =
            "Provide either `name` or `sessionPath`, not both. `name` addresses a subagent in this session's registry; " +
            "`sessionPath` resumes a recorded session (.jsonl) file directly.";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }
        if (!requestedName && !requestedSessionPath) {
          const err =
            "Provide the subagent's `name` to steer (if running) or resume (if finished), " +
            "or `sessionPath` to resume a recorded session file directly.";
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        const parent = captureParent(ctx);
        const parentArtifactDir = parent.artifactDir;
        // ── Steer a running subagent ──
        // A name that matches a currently-running subagent always steers it.
        // Path-addressed messages skip this: the still-running guard below
        // redirects them to a steer by the running entry's own name.
        if (requestedName) {
          const runningMatch = Array.from(runningSubagents.values()).find((r) =>
            r.parentIdentity === parent.identity && r.name === requestedName);
          if (runningMatch) {
            return handleSubagentSteer({ name: requestedName, message: params.message }, undefined, runningMatch);
          }
          // A fallback successor supersedes its finalized primary for name-addressed messages.
          const starting = Array.from(sessionReservations.values()).reverse().find((r) =>
            r.parentIdentity === parent.identity && r.name === requestedName);
          if (starting) return joinStartingSession(starting, params.message);
        }

        // ── Resume a finished session by name or by session file path ──
        const message = params.message;
        const { autoExit, interactive } = resolveResumeLaunchBehavior();
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);
        const runId = `${id}-${Math.random().toString(16).slice(2, 10)}`;

        let sessionPath: string;
        let name: string;
        let resumedSessionId: string;
        if (requestedName) {
          // Resolve the name to its session file via this session's registry.
          const entry = resolveNameInRegistry(parentArtifactDir, requestedName);
          if (!entry) {
            const known = Object.keys(readNameRegistry(parentArtifactDir));
            const err =
              `No subagent named "${requestedName}" in this session. ` +
              (known.length > 0
                ? `Known subagents: ${known.join(", ")}.`
                : "No subagents have been spawned in this session yet.");
            return { content: [{ type: "text" as const, text: err }], details: { error: err } };
          }

          const registeredPath = entry.sessionFile;
          if (registeredPath && readSubagentLoadout(registeredPath)?.cli === "claude") return lifecycleError(CLAUDE_MESSAGE_ERROR);
          if (!registeredPath || !existsSync(registeredPath)) {
            const err =
              `Subagent "${requestedName}" is registered but its session file is gone ` +
              `(${registeredPath}). It cannot be resumed. Spawn a fresh subagent instead.`;
            return { content: [{ type: "text" as const, text: err }], details: { error: err } };
          }

          sessionPath = canonicalSessionPath(registeredPath);
          name = requestedName; // identity preservation: the resumed run reclaims its name
          resumedSessionId = entry.sessionId ?? getSessionId(sessionPath) ?? requestedName;
        } else {
          // Resolve a recorded session file directly, bypassing the registry.
          // This reaches sessions missing from this session's registry — e.g.
          // after a pi restart, or children of a nested subagent.
          // Validated above: exactly one of name/sessionPath is set.
          sessionPath = resolve(requestedSessionPath as string);
          if (!existsSync(sessionPath)) {
            const err =
              `No session file at "${requestedSessionPath}". Pass the path to a recorded subagent session (.jsonl) file — ` +
              `the path is reported in the subagent's completion notice.`;
            return { content: [{ type: "text" as const, text: err }], details: { error: err } };
          }

          sessionPath = canonicalSessionPath(sessionPath);
          name = reclaimNameForSessionPath(parentArtifactDir, sessionPath, parent.identity);
          resumedSessionId = getSessionId(sessionPath) ?? name;
        }

        const sessionKey = canonicalSessionPath(sessionPath);
        const starting = sessionReservations.get(sessionKey);
        if (starting) return joinStartingSession(starting, params.message);

        // Guard: never resume a session that is still running — two processes
        // mutating the same .jsonl corrupts it. Steer it by name instead.
        for (const r of runningSubagents.values()) {
          if (canonicalSessionPath(r.sessionFile) === sessionKey) {
            return handleSubagentSteer({ name: r.name, message: params.message }, undefined, r);
          }
        }

        // Reconstruct the sandbox from the snapshot written at spawn time.
        // Without it we cannot safely resume: relaunching bare would load every
        // global extension + the full toolset. Refuse rather than escalate.
        const loadout = readSubagentLoadout(sessionPath);
        if (!loadout) {
          const err =
            `Cannot safely resume "${name}": no sandbox snapshot found for this session ` +
            `(${loadoutSidecarPath(sessionPath)} is missing — it predates sandboxed resume, or its sidecar was removed). ` +
            `Resuming would relaunch with all global extensions and the full toolset, so this is refused. ` +
            `Re-run the task as a fresh subagent instead.`;
          return { content: [{ type: "text" as const, text: err }], details: { error: err } };
        }

        if (loadout.cli === "claude") return lifecycleError(CLAUDE_MESSAGE_ERROR);
        const reservedName = nameReservationKey(name, parent.identity);
        if (reservedNames.has(reservedName) || Array.from(runningSubagents.values()).some((r) =>
            r.parentIdentity === parent.identity && r.name === name)) {
          return lifecycleError(`Subagent name "${name}" is already starting or running.`);
        }
        let releaseAdmission: () => void;
        try {
          const defaults = loadout.agent ? loadAgentDefaults(loadout.agent) : null;
          releaseAdmission = reserveProfileAdmission(parent.identity, loadout.agent ?? null, defaults);
        } catch (error) { return lifecycleError(error); }
        reservedNames.add(reservedName);
        const reservation = reserveSession(sessionPath, name, parent.identity);
        let owner: SessionOwner | undefined;
        let commandAttempted = false;
        const release = () => {
          sessionReservations.delete(sessionKey);
          reservedNames.delete(reservedName);
          releaseAdmission();
        };
        let surface: string | undefined;
        let launched: RunningSubagent | undefined;
        const previousRegistration = resolveNameInRegistry(parentArtifactDir, name);
        let registered = false;
        try {
        owner = claimSession(sessionPath, runId);
        reservation.owner = owner;
        // Record entry count before resuming so we can extract new messages.
        const entryCountBefore = countSessionEntryLines(sessionPath);

        const resumeLogName = name
          .toLowerCase()
          .replace(/[^a-z0-9\s-]/g, "")
          .replace(/\s+/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "") || "resume";
        surface = await lifecycle.createSurface(name, {
          id,
          logPath: join(parentArtifactDir, "subagent-logs", `${resumeLogName}-${id}.log`),
          sessionFile: sessionPath,
        });
        if (getSurfaceBackend(surface) === "tmux") {
          await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
        }

        const artifactDir = parentArtifactDir;
        const activityFile = getSubagentActivityFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });

        // Build pi resume command, replaying the spawn-time sandbox snapshot.
        const { parts, resumeMsgFile } = buildResumeCommandParts(sessionPath, loadout, {
          artifactDir,
          name,
          message,
        });

        // Build env prefix — replay the snapshot's config dir + spawn whitelist
        // so the resumed process resolves the same agents/extensions and keeps
        // the same nested-spawn restriction it originally ran with.
        const resumeEnvParts: string[] = [];
        if (hasBash(loadout.toolAllowlist)) resumeEnvParts.push("PI_BASH_GUARD_APPROVAL_MODE=deny");
        const resumeAgentDir = loadout.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? null;
        if (resumeAgentDir) {
          resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(resumeAgentDir)}`);
        }
        if (loadout.spawnable && loadout.spawnable.length > 0) {
          resumeEnvParts.push(`PI_SUBAGENT_ALLOWED=${shellEscape(loadout.spawnable.join(","))}`);
        }
        if (loadout.agent) {
          resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(loadout.agent)}`);
        }
        resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
        resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
        resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
        resumeEnvParts.push(`PI_SUBAGENT_RUN_ID=${shellEscape(runId)}`);
        resumeEnvParts.push(`PI_SUBAGENT_OWNER_TOKEN=${shellEscape(owner.ownerToken)}`);
        resumeEnvParts.push(`PI_SUBAGENT_BACKEND=${shellEscape(getSurfaceBackend(surface))}`);
        resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
        if (autoExit) {
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=1`);
        }
        const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

        // Resume in the subagent's original cwd so its tools (safe_bash, edits)
        // operate where they did before.
        const resumeCdPrefix = loadout.cwd ? `cd ${shellEscape(loadout.cwd)} && ` : "";

        clearRunSignals(sessionPath);
        const command = wrapCommandWithCompletion(`${resumeCdPrefix}exec env ${resumeEnvPrefix}${parts.join(" ")}`, `${sessionPath}.complete`, runId, owner.ownerToken);
        const launchScriptFile = join(
          artifactDir,
          "subagent-scripts",
          `${name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
        );
        registerName(parentArtifactDir, name, { sessionFile: sessionPath, sessionId: resumedSessionId });
        registered = true;
        commandAttempted = true;
        await lifecycle.sendLongCommand(surface, command, {
          scriptPath: launchScriptFile,
          scriptPreamble: [
            `# Subagent resume script for ${name}`,
            `# Generated: ${new Date().toISOString()}`,
            `# Session: ${sessionPath}`,
            `# Surface: ${surface}`,
            ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
          ].join("\n"),
        });

        // Register as a running subagent for widget tracking
        const running: RunningSubagent = {
          id,
          runId,
          parentIdentity: parent.identity,
          ownerToken: owner.ownerToken,
          name,
          task: message,
          agent: loadout.agent ?? undefined,
          surface,
          startTime,
          sessionFile: sessionPath,
          launchScriptFile,
          logFile: getBackgroundSurfaceLogPath(surface),
          activityFile,
          interactive,
          statusState: createStatusState({
            source: "pi",
            startTimeMs: startTime,
            model: loadout.model ?? undefined,
            thinking: loadout.thinking ?? undefined,
          }),
        };
        launched = running;
        runningSubagents.set(id, running);
        reservation.resolve(running);
        startWidgetRefresh();
        startStatusRefresh(pi);

        // Fire-and-forget watcher
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        lifecycle.watchSubagent(running, watcherAbort.signal)
          .then((result) => {
            if (finalizeInterruptedRun(pi, running, { ...result, sessionId: resumedSessionId })) return;
            updateWidget();

            const allEntries = getNewEntries(sessionPath, entryCountBefore);
            const summary = findLastAssistantMessage(allEntries) ??
              (result.errorMessage
                ? `Subagent error: ${result.errorMessage}`
                : result.exitCode !== 0
                  ? `Resumed session exited with code ${result.exitCode}`
                  : "Resumed session exited without new output");
            const presentation = resolveResultPresentation(
              { ...result, summary, sessionFile: sessionPath, sessionId: resumedSessionId },
              name,
            );

            pi.sendMessage(
              {
                customType: "subagent_result",
                content: presentation,
                display: true,
                details: {
                  name,
                  task: message,
                  agent: loadout.agent ?? undefined,
                  exitCode: result.exitCode,
                  elapsed: result.elapsed,
                  sessionFile: sessionPath,
                  sessionId: resumedSessionId,
                  ...(result.stats ? { stats: result.stats } : {}),
                  ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
                  ...(result.undeliveredMessages ? { undeliveredMessages: result.undeliveredMessages } : {}),
                  ...(result.ownershipError ? { ownershipError: result.ownershipError } : {}),
                },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .catch((err) => {
            updateWidget();
            pi.sendMessage(
              {
                customType: "subagent_result",
                content: `Resume error: ${err?.message ?? String(err)}`,
                display: true,
                details: { name, error: err?.message },
              },
              { triggerTurn: true, deliverAs: "steer" },
            );
          })
          .finally(() => { if (releaseFinalizedReservations([sessionKey])) release(); });

        return {
          content: [{ type: "text", text: `Session "${name}" resumed.` }],
          details: {
            id,
            name,
            ...(loadout.agent ? { agent: loadout.agent } : {}),
            sessionId: resumedSessionId,
            sessionFile: sessionPath,
            launchScriptFile,
            ...(running.logFile ? { logFile: running.logFile } : {}),
            status: "started",
          },
        };
        } catch (error) {
          reservation.reject(error);
          let failure = error;
          if (surface) {
            try { await lifecycle.closeSurface(surface); }
            catch (cleanupError) { failure = new Error(`${String(error)}; cleanup failed: ${String(cleanupError)}`); }
          }
          if (launched) runningSubagents.delete(launched.id);
          let safe = !owner;
          try {
            if (owner && !commandAttempted) { abandonStartingSession(sessionPath, owner); safe = true; }
            else if (owner) safe = finalizeSession(sessionPath, owner);
          } catch (cleanupError) { failure = new Error(`${String(failure)}; ownership cleanup failed: ${String(cleanupError)}`); }
          if (registered && safe) {
            try { restoreNameRegistration(parentArtifactDir, name, sessionPath, previousRegistration); }
            catch (rollbackError) { failure = new Error(`${String(failure)}; registry rollback failed: ${String(rollbackError)}`); }
          }
          if (safe) release();
          return lifecycleError(`Resume startup failed: ${failure instanceof Error ? failure.message : String(failure)}${safe ? "" : "; writer termination is unproven; ownership retained"}`);
        }
      }),
    });

  registerSubagentsAuditCommand(pi, resolve(SUBAGENTS_DIR, "../.."));

  // /subagent command — request a model-owned tool call with optional overrides.
  // Explicit wording improves clarity; argument fidelity still depends on the model.
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent>[@<model>][:<thinking>] [task]",
    getArgumentCompletions: getSubagentArgumentCompletions,
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /subagent <agent>[@<model>][:<thinking>] [task]",
          "warning",
        );
        return;
      }

      const firstWhitespace = trimmed.search(/\s/);
      const spec = firstWhitespace === -1 ? trimmed : trimmed.slice(0, firstWhitespace);
      const task = firstWhitespace === -1 ? "" : trimmed.slice(firstWhitespace).trim();
      const { agentName, model, thinking } = parseSubagentSpec(spec);

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(
          `Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`,
          "error",
        );
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const attributes = [`agent: ${JSON.stringify(agentName)}`];
      if (model) attributes.push(`model: ${JSON.stringify(model)}`);
      if (thinking) attributes.push(`thinking: ${JSON.stringify(thinking)}`);
      attributes.push(`name: ${JSON.stringify(displayName)}`);
      attributes.push(`task: ${JSON.stringify(taskText)}`);
      const toolCall =
        `${SUBAGENT_DISPATCH_PREFIX} Call subagent({ ${attributes.join(", ")} }) immediately. Do not check subagents_list.`;
      pi.sendUserMessage(toolCall);
    },
  });

  // `/subagent-settings` — backend, status widget, per-agent launch
  // defaults, and orphan cleanup. Replaces `/subagent-mux` and
  // `/subagent-sessions` (both removed, no shims). The page is also the
  // model picker: per-agent overrides persist to the user agent config and outrank
  // markdown defaults, while explicit spawn args still win per-spawn.
  registerSubagentSettingsCommand(pi, {
    discoverAgents: () => discoverAgentDefinitions().map((a) => ({
      name: a.name,
      description: a.description,
    })),
    markdownDefaults: (agentName) => {
      const defs = loadAgentDefaults(agentName);
      const split = splitModelThinking(defs?.model);
      return {
        model: split.model,
        thinking: split.thinking ?? normalizeThinking(defs?.thinking),
        tools: parseCommaList(defs?.tools),
        skills: parseCommaList(defs?.skills),
        subagentAgents: defs?.subagentAgents,
        modelFallback: defs?.modelFallback,
        maxConcurrent: defs?.maxConcurrent,
        maxConcurrentError: defs?.maxConcurrentError,
        disableModelInvocation: defs?.disableModelInvocation,
        cli: defs?.cli,
      };
    },
    toolCatalog: () => getSubagentToolCatalog(pi, latestCtx?.cwd ?? process.cwd()),
    skillCatalog: () => getSubagentSkillCatalog(pi),
    parentActiveTools: () => pi.getActiveTools().filter((tool) =>
      !(SPAWNING_TOOLS as readonly string[]).includes(tool) && !(SUBAGENT_CONTROL_TOOLS as readonly string[]).includes(tool)),
    registryModels: (preferred) => {
      const models: string[] = [];
      try {
        for (const m of latestCtx?.modelRegistry?.getAll() ?? []) {
          if (m.provider && m.id) models.push(`${m.provider}/${m.id}`);
        }
      } catch {}
      const seen = new Set<string>();
      const out: string[] = [];
      for (const value of [preferred, ...models]) {
        const trimmed = value?.trim();
        if (trimmed && !seen.has(trimmed)) {
          seen.add(trimmed);
          out.push(trimmed);
        }
      }
      return out;
    },
    modelSupportsReasoning: (model) => {
      if (!model || !latestCtx?.modelRegistry) return true;
      try {
        const match = latestCtx.modelRegistry.getAll().find((m) =>
          `${m.provider}/${m.id}` === model || m.id === model
        );
        return match?.reasoning !== false;
      } catch {
        return true;
      }
    },
    configState,
    setBackendPreference: (backend) => setSurfaceBackendPreference(backend),
    setStatusEnabled: () => updateWidget(),
    sessionDirs: (ctx) => {
      try {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) return null;
        return {
          sessionDir: ctx.sessionManager.getSessionDir(),
          sessionId: ctx.sessionManager.getSessionId(),
        };
      } catch {
        return null;
      }
    },
    runningSessionFiles: () => Array.from(runningSubagents.values()).map((r) => r.sessionFile),
    artifactDirFor: (sessionDir, sessionId) => getArtifactDir(sessionDir, sessionId),
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const failed = exitCode !== 0 || !!errorMessage;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const stats = (details.stats ?? null) as SessionStats | null;
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const identity = formatSubagentIdentity(name, details.agent, theme);
        let header = `${icon} ${theme.fg("dim", "subagent · ")}${identity}`;
        if (failed) {
          const reason = errorMessage ? "failed (provider/agent error)" : `failed (exit ${exitCode})`;
          header += ` ${theme.fg("dim", "—")} ${theme.fg("error", reason)}`;
        }

        // Quiet footer: model:thinking · tools · duration · ↑in ↓out.
        const footerSegments: string[] = [];
        if (stats?.model) footerSegments.push(theme.fg("dim", [stats.model, stats.thinking && !["off", "none"].includes(stats.thinking.toLowerCase()) ? stats.thinking : null].filter(Boolean).join(":")));
        if (stats) footerSegments.push(theme.fg("dim", `${stats.toolCount} ${stats.toolCount === 1 ? "tool" : "tools"}`));
        footerSegments.push(theme.fg("dim", elapsed));
        if (stats) {
          const io = formatUsageSegments({ ...stats, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 });
          if (io.length) footerSegments.push(theme.fg("dim", io.join(" ")));
        }
        const footerLine = footerSegments.join(theme.fg("dim", " · "));

        // Cache/cost/context are secondary details, shown only on expansion.
        const extraSegments: string[] = [];
        if (options.expanded && stats) {
          const cache = formatUsageSegments({ ...stats, inputTokens: 0, outputTokens: 0, cost: 0 });
          if (cache.length) extraSegments.push(theme.fg("dim", `cache ${cache.join(" ")}`));
          if (stats.cost) extraSegments.push(theme.fg("dim", `$${stats.cost.toFixed(3)}`));
          if (stats.contextTokens > 0) {
            const window = contextWindowFor(stats.model);
            const ctxStr = formatContextUsage(stats.contextTokens, window);
            const pct = window ? (stats.contextTokens / window) * 100 : 0;
            extraSegments.push(theme.fg(pct > 90 ? "error" : pct > 70 ? "warning" : "dim", ctxStr));
          }
        }

        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove follow-up ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nFollow up with subagent_message[\s\S]+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error — auto-retry exhausted\\)\\.\\n\\n`,
            ),
            "",
          );

        const contentLines = [header];
        if (summary) {
          contentLines.push("");
          const summaryLines = summary.split("\n");
          contentLines.push(...(options.expanded ? summaryLines : summaryLines.slice(0, 5)));
          if (!options.expanded && summaryLines.length > 5) {
            contentLines.push(theme.fg("muted", `… ${summaryLines.length - 5} more lines`));
          }
        }

        const dividerWidth = Math.max(0, Math.min(width - 2, visibleWidth(footerLine)));
        contentLines.push("", theme.fg("dim", "─".repeat(dividerWidth)), footerLine);
        if (extraSegments.length) contentLines.push(extraSegments.join(theme.fg("dim", " · ")));

        if (options.expanded) {
          if (details.name || details.sessionFile) {
            contentLines.push("");
            if (details.name) {
              contentLines.push(
                theme.fg(
                  "dim",
                  `Follow up:  subagent_message({ name: "${details.name}", message: "…" })`,
                ),
              );
            }
            if (details.sessionFile) {
              contentLines.push(theme.fg("muted", `Session file: ${details.sessionFile}`));
            }
          }
        } else {
          contentLines.push("", theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
      invalidate() {},
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
      invalidate() {},
    };
  });

  // ── subagent_question message renderer ──
  pi.registerMessageRenderer("subagent_question", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const identity = formatSubagentIdentity(name, details.agent, theme);
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("dim", "subagent · ")}${identity} ${theme.fg("dim", "— asks a question")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.question ?? "");
          contentLines.push("");
          contentLines.push(
            theme.fg("dim", `Reply: subagent_message({ name: "${name}", message: "…" })`),
          );
        } else {
          const preview = (details.question ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
      invalidate() {},
    };
  });

}
