import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: "user" | "assistant" | "toolResult";
    content: Array<{ type: string; text?: string; [key: string]: unknown }>;
    toolCallId?: string;
  };
}

export type SeededSubagentSessionMode = "lineage-only" | "fork";

function getForkContentLines(parentSessionFile: string, parentLeafId: string | null): string[] {
  const entries = readFileSync(parentSessionFile, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry)
    .filter((entry) => entry.type !== "session");

  if (parentLeafId === null) return [];

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let cursor: string | null | undefined = parentLeafId;

  while (cursor) {
    if (visited.has(cursor)) {
      throw new Error(`Cycle detected in parent session branch at ${cursor}`);
    }
    visited.add(cursor);

    const entry = byId.get(cursor);
    if (!entry) {
      throw new Error(`Parent session leaf or ancestor not found: ${cursor}`);
    }
    branch.unshift(entry);
    cursor = entry.parentId;
  }

  // The spawning assistant message is already persisted before tool execution,
  // but its subagent call (and any parallel siblings) have no tool results yet.
  // Providers reject those orphan calls. Preserve every completed call in the
  // resolved branch and strip only calls that do not yet have a result.
  const completedToolCallIds = new Set(
    branch
      .filter((entry): entry is MessageEntry => entry.type === "message")
      .filter((entry) => entry.message.role === "toolResult")
      .map((entry) => entry.message.toolCallId)
      .filter((id): id is string => typeof id === "string"),
  );

  const removedParents = new Map<string, string | null | undefined>();
  const sanitized: SessionEntry[] = [];

  for (const entry of branch) {
    let next = structuredClone(entry);
    if (next.type === "message") {
      const messageEntry = next as MessageEntry;
      if (messageEntry.message.role === "assistant") {
        messageEntry.message.content = messageEntry.message.content.filter(
          (block) =>
            block.type !== "toolCall" ||
            (typeof block.id === "string" && completedToolCallIds.has(block.id)),
        );
        if (messageEntry.message.content.length === 0) {
          removedParents.set(next.id, next.parentId);
          continue;
        }
      }
    }

    let parentId = next.parentId;
    while (parentId && removedParents.has(parentId)) {
      parentId = removedParents.get(parentId);
    }
    next = { ...next, parentId };
    sanitized.push(next);
  }

  return sanitized.map((entry) => JSON.stringify(entry));
}

export function seedSubagentSessionFile(params: {
  mode: SeededSubagentSessionMode;
  parentSessionFile: string;
  parentLeafId: string | null;
  childSessionFile: string;
  childCwd: string;
}): void {
  const header = {
    type: "session",
    version: 3,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd: params.childCwd,
    parentSession: params.parentSessionFile,
  };
  const contentLines =
    params.mode === "fork" ? getForkContentLines(params.parentSessionFile, params.parentLeafId) : [];
  const lines = [JSON.stringify(header), ...contentLines];

  mkdirSync(dirname(params.childSessionFile), { recursive: true });
  writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}

/**
 * A snapshot of everything needed to reconstruct a subagent's sandbox when its
 * session is later resumed via `subagent_message({ sessionId })`.
 *
 * Written next to the session file as `<sessionFile>.loadout.json` at spawn
 * time. Resume replays this exact snapshot so the reincarnated process gets the
 * same `--no-extensions` + `--tools` restriction, model, identity, spawn
 * whitelist, cwd, and config dir it originally ran with — instead of falling
 * back to pi's default (all global extensions + full toolset). Storing the
 * resolved loadout (rather than re-deriving from the agent `.md` by name) keeps
 * resume faithful even if the agent definition is later edited, moved, or
 * deleted.
 */
export interface SubagentLoadout {
  /** Agent profile name (for PI_SUBAGENT_AGENT); null for agentless spawns. */
  agent: string | null;
  /** The `--tools` allowlist string, or null when the spawn was unrestricted. */
  toolAllowlist: string | null;
  /** Model id (without thinking suffix), or null to use the session default. */
  model: string | null;
  /** Thinking level appended to the model as `model:level`, or null. */
  thinking: string | null;
  /** How the identity text was applied: append/replace, or null. */
  systemPromptMode: "append" | "replace" | null;
  /** The system-prompt/identity text, only when it lived in the system prompt. */
  identity: string | null;
  /** Agents this subagent was allowed to spawn (for PI_SUBAGENT_ALLOWED). */
  spawnable: string[] | null;
  /** Whether the agent auto-exits (informational; resume forces autonomous). */
  autoExit: boolean;
  /** Working directory the subagent ran in, or null. */
  cwd: string | null;
  /** PI_CODING_AGENT_DIR the subagent resolved config/extensions from, or null. */
  agentDir: string | null;
}

/** Path of the loadout sidecar written next to a subagent session file. */
export function loadoutSidecarPath(sessionFile: string): string {
  return `${sessionFile}.loadout.json`;
}

/**
 * Path of the subagents directory scoped within a parent session's artifact directory.
 * Path convention: <sessionDir>/artifacts/<parentSessionId>/subagents/
 */
export function getSubagentSessionDir(artifactDir: string): string {
  return join(artifactDir, "subagents");
}

/** Persist a subagent's resolved sandbox loadout beside its session file. */
export function writeSubagentLoadout(sessionFile: string, loadout: SubagentLoadout): void {
  try {
    writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify(loadout), "utf8");
  } catch {
    // Best-effort: a missing snapshot only means resume will refuse, never that
    // it launches unrestricted.
  }
}

/** Read a subagent's loadout snapshot, or null if absent/unparseable. */
export function readSubagentLoadout(sessionFile: string): SubagentLoadout | null {
  try {
    const p = loadoutSidecarPath(sessionFile);
    if (!existsSync(p)) return null;
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SubagentLoadout;
  } catch {
    return null;
  }
}

// ── Name registry ────────────────────────────────────────────────────────────
// Each spawner session (the top-level pi session, or a worker that spawns its
// own children) gets a registry mapping a subagent's display name to the
// session file it ran in. Names are unique per spawner session and persist on
// disk, so `subagent_message({ name })` can steer a running subagent or resume
// a finished one by the same handle — even across a pi restart. The registry
// lives in the spawner's own artifact dir, which is directly addressable from
// the spawner's session id (no sessions-tree scan, so resume stays fast).

export interface NameRegistryEntry {
  /** Absolute path to the subagent's session .jsonl file. */
  sessionFile: string;
  /** Canonical session header id (kept for display/lineage). */
  sessionId: string | null;
}

export type NameRegistry = Record<string, NameRegistryEntry>;

/** Path of the name registry for a given spawner session's artifact dir. */
export function nameRegistryPath(artifactDir: string): string {
  return join(artifactDir, "subagent-registry.json");
}

/** Read a spawner session's name registry, or {} if absent/corrupt. */
export function readNameRegistry(artifactDir: string): NameRegistry {
  try {
    const p = nameRegistryPath(artifactDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as NameRegistry;
  } catch {
    return {};
  }
}

/**
 * Register (or overwrite) a name → session mapping for a spawner session.
 * Writes atomically (temp file + rename) so a concurrent reader never sees a
 * partial registry.
 */
export function registerName(
  artifactDir: string,
  name: string,
  entry: NameRegistryEntry,
): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    const registry = readNameRegistry(artifactDir);
    registry[name] = entry;
    const p = nameRegistryPath(artifactDir);
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf8");
    renameSync(tmp, p);
  } catch {
    // Best-effort: a failed registration only means resume-by-name won't find
    // this subagent later; it never breaks the spawn itself.
  }
}

/** Resolve a name to its registry entry within a spawner session, or null. */
export function resolveNameInRegistry(
  artifactDir: string,
  name: string,
): NameRegistryEntry | null {
  const entry = readNameRegistry(artifactDir)[name];
  return entry && typeof entry.sessionFile === "string" ? entry : null;
}

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Read the canonical session id from a session file's header.
 *
 * pi's `--session <id>` flag resolves against this header `id` (exact match,
 * then prefix), NOT the filename — so this is the value to hand back to the
 * orchestrator for follow-ups.
 */
/**
 * Read only the first line of a file without loading the whole thing into
 * memory. Session files grow to many MB, but the header we need is always the
 * first JSON line, so reading a small prefix keeps header lookups cheap — this
 * is what makes scanning a large session tree fast enough to avoid blocking the
 * event loop. Returns the first line (sans trailing newline), or null.
 */
function readFirstLine(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    if (bytes <= 0) return null;
    const nl = buf.indexOf(0x0a); // '\n'
    const end = nl === -1 || nl >= bytes ? bytes : nl;
    return buf.toString("utf8", 0, end);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function getSessionId(sessionFile: string): string | null {
  return readHeaderId(sessionFile);
}

function readHeaderId(sessionFile: string): string | null {
  const firstLine = readFirstLine(sessionFile)?.trim();
  if (!firstLine) return null;
  try {
    const entry = JSON.parse(firstLine) as { type?: string; id?: string };
    return entry.type === "session" && typeof entry.id === "string" ? entry.id : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a session id (or id prefix) to a session file path by scanning every
 * `*.jsonl` under `sessionsRoot` and matching the header `id`. Mirrors pi's own
 * resolution order: exact match first, then prefix match. Most recently
 * modified file wins on ties. Returns null when nothing matches.
 */
/**
 * In-process index of session id → session file, per sessions root.
 *
 * Resolving a session id naively walks every `.jsonl` under the sessions tree
 * and reads each header. With a few thousand sessions that is thousands of
 * synchronous open/read/stat syscalls — on the extension host's single thread
 * that blocks the entire terminal UI for many seconds (measured ~67s on a
 * 2010-file tree). To avoid that, we build the index once per root and cache
 * it; subsequent lookups are O(1). The cache is validated cheaply (a directory
 * listing plus statSync-only mtime checks) on every call, so new sessions are
 * picked up without re-reading unchanged headers and without ever freezing the
 * UI again.
 */
interface SessionIndex {
  idToFile: Map<string, { path: string; mtime: number }>;
  /** file path → mtime when indexed (staleness detection). */
  files: Map<string, number>;
  /** top-level dir signature used to detect newly added cwd dirs. */
  topSig: string;
}
const sessionIndexCache = new Map<string, SessionIndex>();

function topLevelSignature(root: string): string {
  const parts: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return "";
  }
  for (const e of entries) {
    const full = join(root, e.name);
    if (e.isDirectory()) {
      let m = 0;
      try {
        m = statSync(full).mtimeMs;
      } catch {
        /* ignore */
      }
      parts.push(`d:${e.name}:${m}`);
    } else if (e.isFile() && e.name.endsWith(".jsonl")) {
      parts.push(`f:${e.name}`);
    }
  }
  parts.sort();
  return parts.join("|");
}

/** Recursively index new/changed .jsonl files under dir into idx. */
function indexDir(dir: string, idx: SessionIndex): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      indexDir(full, idx);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      let mtime = 0;
      try {
        mtime = statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const known = idx.files.get(full);
      if (known !== undefined && known === mtime) continue; // unchanged
      const id = readHeaderId(full); // only read headers for new/changed files
      idx.files.set(full, mtime);
      if (!id) continue;
      const prev = idx.idToFile.get(id);
      if (!prev || mtime >= prev.mtime) {
        idx.idToFile.set(id, { path: full, mtime });
      }
    }
  }
}

function getSessionIndex(sessionsRoot: string): SessionIndex {
  let idx = sessionIndexCache.get(sessionsRoot);
  const sig = topLevelSignature(sessionsRoot);
  if (!idx) {
    idx = { idToFile: new Map(), files: new Map(), topSig: sig };
    sessionIndexCache.set(sessionsRoot, idx);
    indexDir(sessionsRoot, idx); // first build: full scan, once per process
  } else if (idx.topSig !== sig) {
    idx.topSig = sig;
    indexDir(sessionsRoot, idx); // a cwd dir was added/changed: incremental rescan
  } else {
    indexDir(sessionsRoot, idx); // cheap: stats files, reads only new/changed headers
  }
  return idx;
}

export function resolveSessionFileById(sessionId: string, sessionsRoot: string): string | null {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

function lookupSessionIndex(
  idx: { idToFile: Map<string, { path: string; mtime: number }> },
  sessionId: string,
): string | null {
  // Exact match first.
  const exact = idx.idToFile.get(sessionId);
  if (exact && existsSync(exact.path)) return exact.path;

  // Prefix match: most recently modified wins (ids are unique in practice, so
  // this is only a convenience for hand-typed short prefixes).
  let best: { path: string; mtime: number } | null = null;
  for (const [id, rec] of idx.idToFile) {
    if (!id.startsWith(sessionId)) continue;
    if (!existsSync(rec.path)) continue;
    if (!best || rec.mtime > best.mtime) best = rec;
  }
  return best ? best.path : null;
}

/**
 * Async variant used by the interactive resume path. Index building/refresh is
 * synchronous I/O, which can take many seconds on a cold OS page cache with a
 * few thousand sessions; running it synchronously would block the extension
 * host's single thread and freeze the terminal UI. Deferring to a macrotask
 * keeps the event loop responsive. The heavy work only happens on the first
 * resolution per process (and incrementally thereafter); warm lookups are ~50ms.
 */
export async function resolveSessionFileByIdAsync(
  sessionId: string,
  sessionsRoot: string,
): Promise<string | null> {
  if (!sessionId || !existsSync(sessionsRoot)) return null;
  // Let the event loop breathe (and the UI repaint) before the sync scan.
  await new Promise<void>((r) => setImmediate(r));
  const idx = getSessionIndex(sessionsRoot);
  return lookupSessionIndex(idx, sessionId);
}

/** Test hook: drop the cached session index so tests start clean. */
export function resetSessionIndexCache(): void {
  sessionIndexCache.clear();
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
/**
 * Count the number of entry lines in a session file without parsing each line
 * into an object. Used by the resume path, which only needs the *count* of
 * pre-existing entries (so it can later slice out the new ones). Parsing every
 * line of a large resumed transcript synchronously at resume time would block
 * the UI; counting newlines is dramatically cheaper.
 */
export function countSessionEntryLines(sessionFile: string): number {
  try {
    const raw = readFileSync(sessionFile, "utf8");
    // Count non-blank lines, mirroring getNewEntries' `.filter(line => line.trim())`
    // but skipping the per-line JSON.parse that makes resume slow on big files.
    let count = 0;
    for (const line of raw.split("\n")) {
      if (line.trim()) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 *
 * Falls back to the `errorMessage` field when the last assistant message has
 * `stopReason: "error"` and no usable text content — this happens when
 * auto-retry exhausts on a provider overload / rate limit / server error, and
 * without this fallback the parent would silently see a stale earlier message.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim() !== "",
      )
      .map((block) => block.text as string);

    if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");

    const stopReason = (msg.message as { stopReason?: unknown }).stopReason;
    const errorMessage = (msg.message as { errorMessage?: unknown }).errorMessage;
    if (
      stopReason === "error" &&
      typeof errorMessage === "string" &&
      errorMessage.trim() !== ""
    ) {
      return `Subagent error: ${errorMessage.trim()}`;
    }
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string,
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number,
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}

export interface SessionStats {
  model: string | null;
  toolCount: number;
  /** Cumulative token usage across all assistant turns. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Current context size: the last assistant turn's totalTokens. */
  contextTokens: number;
  /** Cumulative cost in USD across all assistant turns. */
  cost: number;
}

/**
 * Parse a completed subagent session JSONL into aggregate stats for display:
 * model, tool-call count, cumulative token usage + cost, and current context
 * size. Cumulative usage fields are summed across every assistant turn; the
 * context size is taken from the last assistant turn's `totalTokens` (the live
 * context window occupancy). Returns null if the file can't be read.
 */
export function summarizeSessionStats(sessionFile: string): SessionStats | null {
  let entries: SessionEntry[];
  try {
    entries = readEntries(sessionFile);
  } catch {
    return null;
  }

  const stats: SessionStats = {
    model: null,
    toolCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    cost: 0,
  };

  for (const entry of entries) {
    if (entry.type === "model_change") {
      const modelId = (entry as { modelId?: unknown }).modelId;
      if (typeof modelId === "string" && modelId) stats.model = modelId;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = (entry as MessageEntry).message;
    if (msg.role !== "assistant") continue;

    const model = (msg as { model?: unknown }).model;
    if (typeof model === "string" && model) stats.model = model;

    for (const block of msg.content) {
      if (block.type === "toolCall") stats.toolCount++;
    }

    const usage = (msg as { usage?: Record<string, unknown> }).usage;
    if (usage && typeof usage === "object") {
      const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      stats.inputTokens += num(usage.input);
      stats.outputTokens += num(usage.output);
      stats.cacheReadTokens += num(usage.cacheRead);
      stats.cacheWriteTokens += num(usage.cacheWrite);
      const total = num(usage.totalTokens);
      if (total > 0) stats.contextTokens = total;
      const cost = usage.cost;
      if (cost && typeof cost === "object") stats.cost += num((cost as Record<string, unknown>).total);
    }
  }

  return stats;
}

// ── Scoped child sessions & safe orphan GC ──────────────────────────────────

export const SUBAGENT_MANAGED_MARKER_FILE = ".subagents-managed.json";

export interface SubagentArtifactMarker {
  version: number;
  managedBy: string;
  parentSessionId: string;
  createdAt: number;
}

export function writeArtifactOwnershipMarker(artifactDir: string, parentSessionId: string): void {
  try {
    mkdirSync(artifactDir, { recursive: true });
    const markerPath = join(artifactDir, SUBAGENT_MANAGED_MARKER_FILE);
    const marker: SubagentArtifactMarker = {
      version: 1,
      managedBy: "pi-interactive-subagents",
      parentSessionId,
      createdAt: Date.now(),
    };
    writeFileSync(markerPath, JSON.stringify(marker, null, 2), "utf8");
  } catch {}
}

export function readArtifactOwnershipMarker(artifactDir: string): SubagentArtifactMarker | null {
  const p = join(artifactDir, SUBAGENT_MANAGED_MARKER_FILE);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8"));
    if (
      raw &&
      typeof raw === "object" &&
      raw.managedBy === "pi-interactive-subagents" &&
      raw.version === 1 &&
      typeof raw.parentSessionId === "string" &&
      raw.parentSessionId.length > 0 &&
      typeof raw.createdAt === "number"
    ) {
      return raw as SubagentArtifactMarker;
    }
  } catch {}
  return null;
}

export function hasArtifactOwnershipMarker(artifactDir: string): boolean {
  return readArtifactOwnershipMarker(artifactDir) !== null;
}

/** Pattern for subagent context and sysprompt files generated by this extension. */
const EXTENSION_CONTEXT_FILE_RE = /^([a-z0-9-]+-)?(sysprompt-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(-\d{3})?\.md$/;

export function isExtensionContextFile(filename: string): boolean {
  return EXTENSION_CONTEXT_FILE_RE.test(filename);
}

/**
 * Check if a directory has any recognized extension artifacts (marker, registry, or subagent files).
 * An empty directory or arbitrary dotfiles alone do NOT count as extension-owned.
 */
export function hasExtensionArtifacts(artifactDirPath: string): boolean {
  if (!existsSync(artifactDirPath)) return false;
  if (hasArtifactOwnershipMarker(artifactDirPath)) return true;
  if (existsSync(nameRegistryPath(artifactDirPath))) return true;

  const subagentsDir = join(artifactDirPath, "subagents");
  if (existsSync(subagentsDir)) {
    try {
      const files = readdirSync(subagentsDir);
      if (files.some((f) => f.endsWith(".jsonl") || f.endsWith(".loadout.json"))) {
        return true;
      }
    } catch {}
  }
  return false;
}

export interface CleanDirResult {
  cleanedFilesCount: number;
  cleanedBytes: number;
  dirRemoved: boolean;
  preservedForeignEntries: string[];
}

/**
 * Clean ONLY extension-owned files in an orphan artifact directory, preserving any
 * foreign files, unexpected folders, or foreign context files.
 * If all files in the directory were extension-owned, the artifact directory is removed.
 * If foreign files remain, the directory is left intact with foreign files preserved.
 */
export function cleanExtensionArtifactDir(artifactDirPath: string): CleanDirResult {
  const result: CleanDirResult = {
    cleanedFilesCount: 0,
    cleanedBytes: 0,
    dirRemoved: false,
    preservedForeignEntries: [],
  };

  if (!existsSync(artifactDirPath)) return result;

  // 1. Clean subagents/
  const subagentsDir = join(artifactDirPath, "subagents");
  if (existsSync(subagentsDir)) {
    try {
      const entries = readdirSync(subagentsDir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(subagentsDir, entry.name);
        if (entry.isFile()) {
          if (
            entry.name.endsWith(".jsonl") ||
            entry.name.endsWith(".loadout.json") ||
            entry.name.endsWith(".ask") ||
            entry.name.endsWith(".exit")
          ) {
            try {
              result.cleanedBytes += statSync(full).size;
              unlinkSync(full);
              result.cleanedFilesCount++;
            } catch {}
          }
        } else if (entry.isDirectory() && entry.name === "artifacts") {
          // Nested artifacts
          try {
            const nestedDirs = readdirSync(full, { withFileTypes: true });
            for (const nDir of nestedDirs) {
              if (nDir.isDirectory()) {
                const subRes = cleanExtensionArtifactDir(join(full, nDir.name));
                result.cleanedFilesCount += subRes.cleanedFilesCount;
                result.cleanedBytes += subRes.cleanedBytes;
              }
            }
            if (readdirSync(full).length === 0) {
              rmSync(full, { recursive: true, force: true });
            }
          } catch {}
        }
      }
      if (readdirSync(subagentsDir).length === 0) {
        rmSync(subagentsDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 2. Clean subagent-activity/
  const activityDir = join(artifactDirPath, "subagent-activity");
  if (existsSync(activityDir)) {
    try {
      const entries = readdirSync(activityDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          const full = join(activityDir, entry.name);
          try {
            result.cleanedBytes += statSync(full).size;
            unlinkSync(full);
            result.cleanedFilesCount++;
          } catch {}
        }
      }
      if (readdirSync(activityDir).length === 0) {
        rmSync(activityDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 3. Clean subagent-scripts/
  const scriptsDir = join(artifactDirPath, "subagent-scripts");
  if (existsSync(scriptsDir)) {
    try {
      const entries = readdirSync(scriptsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".sh")) {
          const full = join(scriptsDir, entry.name);
          try {
            result.cleanedBytes += statSync(full).size;
            unlinkSync(full);
            result.cleanedFilesCount++;
          } catch {}
        }
      }
      if (readdirSync(scriptsDir).length === 0) {
        rmSync(scriptsDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 4. Clean subagent-resume/
  const resumeDir = join(artifactDirPath, "subagent-resume");
  if (existsSync(resumeDir)) {
    try {
      const entries = readdirSync(resumeDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          const full = join(resumeDir, entry.name);
          try {
            result.cleanedBytes += statSync(full).size;
            unlinkSync(full);
            result.cleanedFilesCount++;
          } catch {}
        }
      }
      if (readdirSync(resumeDir).length === 0) {
        rmSync(resumeDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 5. Clean context/ (ONLY delete matching extension files; preserve foreign user/custom files)
  const contextDir = join(artifactDirPath, "context");
  if (existsSync(contextDir)) {
    try {
      const entries = readdirSync(contextDir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(contextDir, entry.name);
        if (entry.isFile() && isExtensionContextFile(entry.name)) {
          try {
            result.cleanedBytes += statSync(full).size;
            unlinkSync(full);
            result.cleanedFilesCount++;
          } catch {}
        }
      }
      if (readdirSync(contextDir).length === 0) {
        rmSync(contextDir, { recursive: true, force: true });
      }
    } catch {}
  }

  // 6. Clean subagent-registry.json and .subagents-managed.json
  const registryFile = nameRegistryPath(artifactDirPath);
  if (existsSync(registryFile)) {
    try {
      result.cleanedBytes += statSync(registryFile).size;
      unlinkSync(registryFile);
      result.cleanedFilesCount++;
    } catch {}
  }

  const markerFile = join(artifactDirPath, SUBAGENT_MANAGED_MARKER_FILE);
  if (existsSync(markerFile)) {
    try {
      result.cleanedBytes += statSync(markerFile).size;
      unlinkSync(markerFile);
      result.cleanedFilesCount++;
    } catch {}
  }

  // Check remaining items
  try {
    const remaining = readdirSync(artifactDirPath);
    if (remaining.length === 0) {
      rmSync(artifactDirPath, { recursive: true, force: true });
      result.dirRemoved = true;
    } else {
      result.preservedForeignEntries = remaining;
    }
  } catch {}

  return result;
}

export function isExtensionOwnedArtifactDir(artifactDirPath: string): boolean {
  return hasExtensionArtifacts(artifactDirPath);
}

export interface ParentAbsenceOptions {
  activeSessionIds?: Set<string>;
  runningSessionFiles?: string[];
  topLevelSessionFiles?: Array<{ name: string; fullPath: string }>;
  headerIdCache?: Map<string, string | null>;
}

/**
 * Check whether a parent session ID is conclusively absent from a session directory.
 * Returns false if ANY session file in the directory has a matching header ID or filename,
 * or if the session ID is in the active list.
 */
export function isParentSessionConclusivelyAbsent(
  sessionId: string,
  sessionDir: string,
  opts?: ParentAbsenceOptions,
): boolean {
  if (!sessionId || !sessionDir || !existsSync(sessionDir)) return false;

  // 1. Active session ID check
  if (opts?.activeSessionIds && opts.activeSessionIds.has(sessionId)) {
    return false;
  }

  // 2. Active running subagent check
  if (opts?.runningSessionFiles) {
    const artifactSegment = `/artifacts/${sessionId}/`;
    for (const f of opts.runningSessionFiles) {
      if (f.includes(artifactSegment)) return false;
    }
  }

  // 3. Scan top-level session files in sessionDir
  try {
    let sessionFiles = opts?.topLevelSessionFiles;
    if (!sessionFiles) {
      const entries = readdirSync(sessionDir, { withFileTypes: true });
      sessionFiles = [];
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          sessionFiles.push({ name: entry.name, fullPath: join(sessionDir, entry.name) });
        }
      }
    }

    for (const file of sessionFiles) {
      // Fast filename check
      if (file.name === `${sessionId}.jsonl` || file.name.endsWith(`_${sessionId}.jsonl`)) {
        return false;
      }
      // Header ID check (using cache if provided)
      let headerId: string | null = null;
      if (opts?.headerIdCache) {
        if (opts.headerIdCache.has(file.fullPath)) {
          headerId = opts.headerIdCache.get(file.fullPath)!;
        } else {
          headerId = readHeaderId(file.fullPath);
          opts.headerIdCache.set(file.fullPath, headerId);
        }
      } else {
        headerId = readHeaderId(file.fullPath);
      }

      if (headerId === sessionId) {
        return false;
      }
    }
  } catch {
    return false;
  }

  return true;
}

export interface OrphanArtifactCandidate {
  sessionId: string;
  dir: string;
  mtimeMs: number;
  fileCount: number;
  sizeBytes: number;
}

export interface OrphanGcOptions {
  dryRun?: boolean;
  minAgeMs?: number;
  currentSessionId?: string | null;
  activeSessionIds?: Set<string>;
  runningSessionFiles?: string[];
}

export interface OrphanGcResult {
  scannedCount: number;
  orphanCount: number;
  cleanedDirs: string[];
  cleanedFilesCount: number;
  cleanedBytes: number;
  preservedForeignDirs: string[];
  candidates: OrphanArtifactCandidate[];
  skippedDirs: Array<{ path: string; reason: string }>;
  errors: Array<{ path: string; error: string }>;
}

function calculateDirStats(dir: string): { fileCount: number; sizeBytes: number } {
  let fileCount = 0;
  let sizeBytes = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = calculateDirStats(full);
        fileCount += sub.fileCount;
        sizeBytes += sub.sizeBytes;
      } else if (entry.isFile()) {
        fileCount++;
        try {
          sizeBytes += statSync(full).size;
        } catch {}
      }
    }
  } catch {}
  return { fileCount, sizeBytes };
}

/**
 * Scan sessionDir/artifacts/ and return all orphan artifact directories
 * whose parent session is conclusively absent.
 */
export function findOrphanArtifactDirs(
  sessionDir: string,
  options?: OrphanGcOptions,
): OrphanArtifactCandidate[] {
  const artifactsRoot = join(sessionDir, "artifacts");
  if (!existsSync(artifactsRoot)) return [];

  const candidates: OrphanArtifactCandidate[] = [];
  const minAgeMs = options?.minAgeMs ?? (24 * 60 * 60 * 1000);
  const now = Date.now();

  const activeIds = new Set<string>(options?.activeSessionIds ?? []);
  if (options?.currentSessionId) activeIds.add(options.currentSessionId);

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(artifactsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  // Pre-collect top-level session files once across all orphan candidate checks.
  // Fail closed: inability to inspect parent sessions must never become evidence
  // that every managed artifact directory is orphaned.
  let topLevelSessionFiles: Array<{ name: string; fullPath: string }>;
  try {
    const dirEntries = readdirSync(sessionDir, { withFileTypes: true });
    topLevelSessionFiles = [];
    for (const de of dirEntries) {
      if (de.isFile() && de.name.endsWith(".jsonl")) {
        topLevelSessionFiles.push({ name: de.name, fullPath: join(sessionDir, de.name) });
      }
    }
  } catch {
    return [];
  }
  const headerIdCache = new Map<string, string | null>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sessionId = entry.name;
    const fullPath = join(artifactsRoot, sessionId);

    // Never consider active current session
    if (activeIds.has(sessionId)) continue;

    // Safety: check directory age (must be older than minAgeMs to avoid races)
    let mtime = 0;
    try {
      mtime = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    if (minAgeMs > 0 && now - mtime < minAgeMs) continue;

    // Manual cleanup is marker-only. Heuristics such as a familiar registry or
    // filename are not sufficient proof of ownership. The marker must also
    // identify the directory being considered, which prevents copied or stale
    // markers from authorizing cleanup of a different session's artifacts.
    const marker = readArtifactOwnershipMarker(fullPath);
    if (!marker || marker.parentSessionId !== sessionId) continue;

    // Check if parent session is conclusively absent
    if (isParentSessionConclusivelyAbsent(sessionId, sessionDir, {
      activeSessionIds: activeIds,
      runningSessionFiles: options?.runningSessionFiles,
      topLevelSessionFiles,
      headerIdCache,
    })) {
      const { fileCount, sizeBytes } = calculateDirStats(fullPath);
      candidates.push({
        sessionId,
        dir: fullPath,
        mtimeMs: mtime,
        fileCount,
        sizeBytes,
      });
    }
  }

  return candidates;
}

/**
 * Safely clean orphan artifact directories whose parent sessions no longer exist.
 * Conservative: only deletes extension-owned content when parent is conclusively absent.
 */
export function cleanOrphanArtifactDirs(
  sessionDir: string,
  options?: OrphanGcOptions,
): OrphanGcResult {
  const artifactsRoot = join(sessionDir, "artifacts");
  const result: OrphanGcResult = {
    scannedCount: 0,
    orphanCount: 0,
    cleanedDirs: [],
    cleanedFilesCount: 0,
    cleanedBytes: 0,
    preservedForeignDirs: [],
    candidates: [],
    skippedDirs: [],
    errors: [],
  };

  if (!existsSync(artifactsRoot)) return result;

  const candidates = findOrphanArtifactDirs(sessionDir, options);
  result.candidates = candidates;
  result.orphanCount = candidates.length;

  try {
    const totalEntries = readdirSync(artifactsRoot, { withFileTypes: true });
    result.scannedCount = totalEntries.filter((e) => e.isDirectory()).length;
  } catch {}

  if (options?.dryRun) {
    return result;
  }

  for (const candidate of candidates) {
    try {
      const cleanRes = cleanExtensionArtifactDir(candidate.dir);
      result.cleanedFilesCount += cleanRes.cleanedFilesCount;
      result.cleanedBytes += cleanRes.cleanedBytes;
      if (cleanRes.dirRemoved) {
        result.cleanedDirs.push(candidate.dir);
      } else if (cleanRes.preservedForeignEntries.length > 0) {
        result.preservedForeignDirs.push(candidate.dir);
      }
    } catch (err: any) {
      result.errors.push({
        path: candidate.dir,
        error: err?.message ?? String(err),
      });
    }
  }

  return result;
}
