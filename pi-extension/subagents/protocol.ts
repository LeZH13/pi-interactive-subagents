import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";

export interface SessionOwner {
  ownerToken: string;
  runId: string;
  phase: "starting" | "open" | "closed" | "completed";
  pid?: number;
  commandStarted?: boolean;
  dispatched: string[];
  recovered: string[];
  previous?: { owner: SessionOwner; completion: CompletionRecord };
}
export interface InboxMessage {
  messageId: string;
  body: string;
  runId: string;
  createdAt: number;
  /** Diagnostic source added when reporting retained items; never rewrites the immutable record. */
  sessionFile?: string;
}
export interface CompletionRecord {
  type: "completion";
  ownerToken: string;
  runId: string;
  completedAt: number;
  exitCode: number;
  error?: { type: "error"; ownerToken: string; runId: string; errorMessage?: string };
}
export class SessionBusyError extends Error {}

/** Paths and their existing ancestors share one protocol. Hard-link aliases cannot safely share its sidecars. */
export function canonicalSessionPath(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) {
    const canonical = realpathSync(absolute);
    if (statSync(canonical).isFile() && statSync(canonical).nlink !== 1) {
      throw new Error(`Cannot manage multiply hard-linked session "${canonical}". Use a single session path.`);
    }
    return canonical;
  }
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonicalSessionPath(parent), basename(absolute));
}

export function protocolDir(sessionFile: string): string { return `${canonicalSessionPath(sessionFile)}.control`; }
function atomicJson(path: string, value: unknown) {
  const tmp = `${path}.tmp-${randomUUID()}`;
  try { writeFileSync(tmp, JSON.stringify(value), "utf8"); renameSync(tmp, path); }
  finally { rmSync(tmp, { force: true }); }
}
function readJson(path: string): any { return JSON.parse(readFileSync(path, "utf8")); }

/** Synchronous, short critical sections. Never steal an ambiguous lock, including after a crash. */
export function withSessionLock<T>(sessionFile: string, action: (dir: string) => T): T {
  const dir = protocolDir(sessionFile);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "lock");
  try { mkdirSync(lock); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessionBusyError(`Session mutex busy or abandoned for "${sessionFile}"; retry after the active operation. No automatic lock recovery is performed.`);
    }
    throw error;
  }
  try { return action(dir); }
  finally { rmSync(lock, { recursive: true }); }
}
/** Startup/wrapper operations may wait briefly for a live critical section, never steal its lock. */
export async function retrySessionOperation<T>(operation: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (!(error instanceof SessionBusyError) || attempt === 99) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function readOwner(dir: string): SessionOwner | undefined {
  const path = join(dir, "owner.json");
  if (!existsSync(path)) return undefined;
  const value = readJson(path);
  if (!value || typeof value.ownerToken !== "string" || !/^[a-f0-9-]{36}$/.test(value.ownerToken) || typeof value.runId !== "string" || !value.runId ||
      !["starting", "open", "closed", "completed"].includes(value.phase) ||
      !Array.isArray(value.dispatched) || !value.dispatched.every((id: unknown) => typeof id === "string") ||
      !Array.isArray(value.recovered) || !value.recovered.every((id: unknown) => typeof id === "string")) {
    throw new Error(`Invalid session ownership at "${path}"; refusing ambiguous writer ownership.`);
  }
  return value;
}
function requireOwner(dir: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): SessionOwner {
  const owner = readOwner(dir);
  if (!owner || owner.ownerToken !== identity.ownerToken || owner.runId !== identity.runId) {
    throw new Error("Session owner token/run does not match; refusing stale or foreign operation.");
  }
  return owner;
}
function matchingError(value: any, identity: Pick<SessionOwner, "ownerToken" | "runId">): value is NonNullable<CompletionRecord["error"]> {
  return value?.type === "error" && value.ownerToken === identity.ownerToken && value.runId === identity.runId &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string");
}
function readCompletion(path: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): CompletionRecord | undefined {
  if (!existsSync(path)) return undefined;
  const done = readJson(path);
  return done?.type === "completion" && done.ownerToken === identity.ownerToken && done.runId === identity.runId &&
    Number.isInteger(done.exitCode) && Number.isFinite(done.completedAt) &&
    (done.error === undefined || matchingError(done.error, identity)) ? done : undefined;
}
function matchingCompletion(sessionFile: string, owner: SessionOwner): CompletionRecord | undefined {
  return readCompletion(`${sessionFile}.complete`, owner);
}
/** Immutable post-exit outcome for this exact writer, independent of subsequent ownership. */
export function readSessionCompletion(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): CompletionRecord | undefined {
  if (!/^[a-f0-9-]{36}$/.test(identity.ownerToken) || !identity.runId) return undefined;
  return readCompletion(join(protocolDir(sessionFile), "completions", `${identity.ownerToken}.json`), identity);
}
function inbox(dir: string): InboxMessage[] {
  const path = join(dir, "inbox");
  if (!existsSync(path)) return [];
  return readdirSync(path).filter((name) => name.endsWith(".json")).sort().map((name) => {
    const item = readJson(join(path, name));
    if (typeof item?.messageId !== "string" || !/^[a-f0-9-]{36}$/.test(item.messageId) || typeof item.body !== "string" || typeof item.runId !== "string") {
      throw new Error(`Invalid immutable inbox record "${name}"; retained for inspection.`);
    }
    return item as InboxMessage;
  });
}
function unacknowledged(dir: string): InboxMessage[] {
  return inbox(dir).filter((item) => !existsSync(join(dir, "acks", `${item.messageId}.json`)));
}

/** A new run may replace an owner only after its matching outer wrapper proves process exit. */
export function claimSession(sessionFile: string, runId: string, fresh = false): SessionOwner {
  sessionFile = canonicalSessionPath(sessionFile);
  return withSessionLock(sessionFile, (dir) => {
    const previous = readOwner(dir);
    if (fresh && (previous || existsSync(sessionFile))) throw new Error(`Fresh session path "${sessionFile}" is already occupied; refusing to overwrite its identity.`);
    if (!previous && !fresh) throw new Error(`Unknown session owner for "${sessionFile}"; resume refused. An updated parent launch and matching wrapper completion are required.`);
    if (previous && !matchingCompletion(sessionFile, previous)) {
      throw new Error(`Session "${sessionFile}" has a ${previous.phase} writer (${previous.runId}); no matching wrapper completion proves termination. Resume refused.`);
    }
    const owner: SessionOwner = { ownerToken: randomUUID(), runId, phase: "starting", dispatched: [],
      recovered: previous ? unacknowledged(dir).map((item) => item.messageId) : [] };
    if (previous) {
      const { previous: _older, ...priorOwner } = previous;
      owner.previous = { owner: priorOwner, completion: matchingCompletion(sessionFile, previous)! };
    }
    atomicJson(join(dir, "owner.json"), owner);
    // The previous completion was consumed by the recorded owner transition, never by a watcher.
    rmSync(`${sessionFile}.complete`, { force: true });
    return owner;
  });
}
/** A stored launch script is single-use too: extension load failures must not allow a duplicate writer. */
export function authorizeLaunch(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): void {
  withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if (owner.phase !== "starting" || owner.commandStarted || matchingCompletion(canonicalSessionPath(sessionFile), owner)) {
      throw new Error("Launch already authorized or writer not starting; refusing duplicate/stale launch script.");
    }
    owner.commandStarted = true;
    atomicJson(join(dir, "owner.json"), owner);
  });
}

export function validateChildOwner(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): void {
  withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if (!owner.commandStarted || matchingCompletion(canonicalSessionPath(sessionFile), owner) ||
        (owner.phase !== "starting" && !(owner.phase === "open" && owner.pid === process.pid))) {
      throw new Error(`Child startup refused for owner phase ${owner.phase}.`);
    }
  });
}
export function openSession(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): void {
  withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if (!owner.commandStarted || matchingCompletion(canonicalSessionPath(sessionFile), owner) ||
        (owner.phase !== "starting" && !(owner.phase === "open" && owner.pid === process.pid))) {
      throw new Error(`Child startup refused for owner phase ${owner.phase}.`);
    }
    owner.phase = "open"; owner.pid = process.pid;
    delete owner.previous;
    atomicJson(join(dir, "owner.json"), owner);
  });
}
/** A continuation reopens delivery for the same live writer, never changes writer ownership. */
export function reopenSessionDelivery(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): void {
  withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if (owner.phase !== "closed" || owner.pid !== process.pid || matchingCompletion(canonicalSessionPath(sessionFile), owner)) {
      throw new Error("Cannot reopen delivery for a foreign, completed, or non-closed writer.");
    }
    owner.phase = "open";
    atomicJson(join(dir, "owner.json"), owner);
  });
}

/** Only pre-command setup failures can abandon a claim without wrapper evidence. */
export function abandonStartingSession(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): void {
  withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if (owner.phase !== "starting" || owner.pid !== undefined || owner.commandStarted) throw new Error("Cannot release ownership after child startup; wrapper completion is required.");
    if (owner.previous) {
      atomicJson(join(dir, "owner.json"), owner.previous.owner);
      atomicJson(`${canonicalSessionPath(sessionFile)}.complete`, owner.previous.completion);
    } else rmSync(join(dir, "owner.json"));
  });
}
export function enqueueMessage(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">, body: string): InboxMessage {
  sessionFile = canonicalSessionPath(sessionFile);
  return withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if ((owner.phase !== "open" && owner.phase !== "starting") || matchingCompletion(sessionFile, owner)) {
      throw new Error("Subagent delivery is closed or its writer has exited; retry with an explicit resume after its completion notice.");
    }
    const item: InboxMessage = { messageId: randomUUID(), body, runId: owner.runId, createdAt: Date.now() };
    const path = join(dir, "inbox"); mkdirSync(path, { recursive: true });
    // hrtime orders same-process enqueues without changing the immutable ID/body.
    atomicJson(join(path, `${item.createdAt}-${process.hrtime.bigint()}-${item.messageId}.json`), item);
    return item;
  });
}

/** Poll and closure share exactly the same mutex as enqueue and owner transitions. */
export function drainInbox(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">, options: {
  branch: readonly any[];
  deliver: (item: InboxMessage) => "question" | "queued";
  close: boolean;
}): { pending: InboxMessage[]; dispatched: number; closed: boolean } {
  return withSessionLock(sessionFile, (dir) => {
    const owner = requireOwner(dir, identity);
    if (owner.phase !== "open") throw new Error(`Cannot drain inbox in owner phase ${owner.phase}.`);
    const persisted = new Set(options.branch.filter((entry) => entry.type === "custom_message" && entry.customType === "subagent_steer" &&
      typeof entry.details?.messageId === "string" && typeof entry.details?.runId === "string")
      .map((entry) => `${entry.details.messageId}\0${entry.details.runId}`));
    const ack = (item: InboxMessage, kind: string) => {
      const path = join(dir, "acks"); mkdirSync(path, { recursive: true });
      atomicJson(join(path, `${item.messageId}.json`), { messageId: item.messageId, runId: owner.runId, kind });
      owner.dispatched = owner.dispatched.filter((id) => id !== item.messageId);
    };
    for (const item of unacknowledged(dir)) if (persisted.has(`${item.messageId}\0${item.runId}`)) ack(item, "persisted");
    let dispatched = 0;
    for (const item of unacknowledged(dir)) {
      if (owner.dispatched.includes(item.messageId)) continue;
      if (item.runId !== owner.runId && !owner.recovered.includes(item.messageId)) continue;
      // Persist the dispatch marker before the void SDK call. A post-send disk failure must not resend a queued ID.
      owner.dispatched.push(item.messageId);
      atomicJson(join(dir, "owner.json"), owner);
      let outcome: "question" | "queued";
      try { outcome = options.deliver(item); }
      catch (error) {
        owner.dispatched = owner.dispatched.filter((id) => id !== item.messageId);
        atomicJson(join(dir, "owner.json"), owner);
        throw error;
      }
      if (outcome === "question") ack(item, "question");
      dispatched++;
      atomicJson(join(dir, "owner.json"), owner);
    }
    const pending = unacknowledged(dir);
    const closed = options.close && pending.length === 0;
    if (closed) owner.phase = "closed";
    atomicJson(join(dir, "owner.json"), owner);
    return { pending, dispatched, closed };
  });
}
export function pendingMessages(sessionFile: string): InboxMessage[] {
  sessionFile = canonicalSessionPath(sessionFile);
  return withSessionLock(sessionFile, (dir) => unacknowledged(dir).map((item) => ({ ...item, sessionFile })));
}
export function recordCompletion(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">, exitCode: number): void {
  sessionFile = canonicalSessionPath(sessionFile);
  withSessionLock(sessionFile, (dir) => {
    requireOwner(dir, identity);
    const done: CompletionRecord = { type: "completion", ...identity, completedAt: Date.now(), exitCode };
    // Capture the child-authored rich failure before a successor clears live run signals.
    try {
      const failure = readJson(`${sessionFile}.exit`);
      if (matchingError(failure, identity)) done.error = failure;
    } catch {}
    const completed = join(dir, "completions"); mkdirSync(completed, { recursive: true });
    atomicJson(join(completed, `${identity.ownerToken}.json`), done);
    atomicJson(`${sessionFile}.complete`, done);
  });
}
/** Remove only a fully validated, terminated protocol group. Unknown content retains the whole group. */
export function cleanCompletedSession(sessionFile: string): { removed: boolean; cleanedFilesCount: number; cleanedBytes: number } {
  const result = { removed: false, cleanedFilesCount: 0, cleanedBytes: 0 };
  const control = `${sessionFile}.control`;
  const regularFile = (path: string) => { const stat = lstatSync(path); return stat.isFile() && stat.nlink === 1; };
  try {
    // Do not canonicalize a symlink into authorization to delete its target.
    if (!lstatSync(control).isDirectory() || (existsSync(sessionFile) && !regularFile(sessionFile))) return result;
    withSessionLock(sessionFile, (dir) => {
      const owner = readOwner(dir);
      if (!owner || !readSessionCompletion(sessionFile, owner)) return;
      const files: string[] = [];
      const directories: string[] = [];
      const records = new Map<string, InboxMessage>();
      const completedRuns = new Set<string>();
      const root = readdirSync(dir, { withFileTypes: true });
      for (const entry of root) {
        const path = join(dir, entry.name);
        if (entry.name === "lock" && entry.isDirectory() && readdirSync(path).length === 0) continue;
        if (entry.name === "owner.json" && regularFile(path)) { files.push(path); continue; }
        if (!["inbox", "acks", "completions"].includes(entry.name) || !entry.isDirectory()) return;
        directories.push(path);
        for (const item of readdirSync(path, { withFileTypes: true })) {
          const recordPath = join(path, item.name);
          if (!item.isFile() || !regularFile(recordPath)) return;
          files.push(recordPath);
        }
      }
      // Validate the existing protocol formats and their identities, not just JSON suffixes.
      for (const path of files.filter((path) => dirname(path) === join(dir, "completions"))) {
        const token = basename(path, ".json");
        const value = readJson(path);
        if (!/^[a-f0-9-]{36}$/.test(token) || typeof value?.runId !== "string" || !value.runId ||
            !readCompletion(path, { ownerToken: token, runId: value.runId })) return;
        completedRuns.add(value.runId);
      }
      for (const item of inbox(dir)) {
        if (!Number.isFinite(item.createdAt) || !completedRuns.has(item.runId)) return;
        if (records.has(item.messageId)) return;
        records.set(item.messageId, item);
      }
      for (const path of files.filter((path) => dirname(path) === join(dir, "inbox"))) {
        const item = readJson(path) as InboxMessage;
        if (!new RegExp(`^${item.createdAt}-[0-9]+-${item.messageId}\\.json$`).test(basename(path))) return;
      }
      for (const path of files.filter((path) => dirname(path) === join(dir, "acks"))) {
        const ack = readJson(path);
        if (!records.has(ack?.messageId) || basename(path) !== `${ack.messageId}.json` ||
            !completedRuns.has(ack.runId) || !["question", "persisted"].includes(ack.kind)) return;
      }
      const name = basename(sessionFile);
      for (const entry of readdirSync(dirname(sessionFile), { withFileTypes: true })) {
        if (entry.name !== name && !entry.name.startsWith(`${name}.`)) continue;
        if (entry.name === `${name}.control`) continue;
        const path = join(dirname(sessionFile), entry.name);
        if (!entry.isFile() || !regularFile(path)) return;
        const suffix = entry.name.slice(name.length);
        if (!["", ".loadout.json", ".complete", ".exit", ".ask"].includes(suffix)) return;
        if (suffix === ".complete" && !readCompletion(path, owner)) return;
        if (suffix === ".exit" && !matchingError(readJson(path), owner)) return;
        files.push(path);
      }
      // All validation precedes deletion, while owner transitions and enqueue are excluded.
      for (const path of files) {
        const size = lstatSync(path).size;
        unlinkSync(path);
        result.cleanedFilesCount++; result.cleanedBytes += size;
      }
      for (const path of directories) rmdirSync(path);
      result.removed = true;
    });
    // Only empty-directory removal is safe after releasing the mutex. A new claim wins intact.
    if (result.removed) {
      try { rmdirSync(control); } catch { result.removed = false; }
    }
  } catch { /* Busy, malformed, symlinked or ambiguous groups remain recoverable. */ }
  return result;
}

export function finalizeSession(sessionFile: string, identity: Pick<SessionOwner, "ownerToken" | "runId">): boolean {
  sessionFile = canonicalSessionPath(sessionFile);
  return withSessionLock(sessionFile, (dir) => {
    const owner = readOwner(dir);
    if (!owner || owner.ownerToken !== identity.ownerToken || owner.runId !== identity.runId) {
      return readSessionCompletion(sessionFile, identity) !== undefined;
    }
    if (!matchingCompletion(sessionFile, owner)) return false;
    owner.phase = "completed";
    atomicJson(join(dir, "owner.json"), owner);
    return true;
  });
}
