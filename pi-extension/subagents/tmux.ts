/**
 * tmux surface layer — the only terminal multiplexer this extension supports.
 *
 * Everything the extension does to a pane goes through the small API in this
 * file: create/split a pane, type a command into it, read its screen, close
 * it, and poll for exit. Keeping the tmux calls isolated here means index.ts
 * stays testable without a multiplexer running.
 *
 * Panes are identified by tmux pane ids (e.g. `%12`). Splits always target
 * the parent pi's pane (`$TMUX_PANE`) so they follow the agent rather than
 * the user's focus.
 */
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside tmux with the tmux binary on PATH.
 * `TMUX` is set by tmux in every process it spawns (shell or pane).
 */
export function isTmuxAvailable(): boolean {
  return !!process.env.TMUX && hasCommand("tmux");
}

export interface MultiplexingConfig {
  enabled: boolean;
}

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");

export function parseMultiplexingConfig(raw: unknown, source = "config.json"): MultiplexingConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid subagent multiplexing config in ${source}: root must be an object`);
  }
  const multiplexing = (raw as Record<string, unknown>).multiplexing;
  if (multiplexing === undefined) return { enabled: true };
  if (multiplexing == null || typeof multiplexing !== "object" || Array.isArray(multiplexing)) {
    throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing must be an object`);
  }
  const keys = Object.keys(multiplexing as Record<string, unknown>);
  const unsupported = keys.filter((key) => key !== "enabled");
  if (unsupported.length) {
    throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing has unsupported key(s): ${unsupported.join(", ")}`);
  }
  const enabled = (multiplexing as Record<string, unknown>).enabled;
  if (typeof enabled !== "boolean") {
    throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing.enabled must be a boolean`);
  }
  return { enabled };
}

export function loadMultiplexingConfig(
  configPath = DEFAULT_CONFIG_PATH,
  examplePath = EXAMPLE_CONFIG_PATH,
): MultiplexingConfig {
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
    return parseMultiplexingConfig(JSON.parse(raw), source);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in subagent config ${source}: ${error.message}`);
    }
    throw error;
  }
}

export function resolveMultiplexingEnabled(
  configured: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.PI_SUBAGENT_DISABLE_TMUX === "1") return false;
  if (env.PI_SUBAGENT_MULTIPLEX === "0") return false;
  if (env.PI_SUBAGENT_MULTIPLEX === "1") return true;
  return configured;
}

let multiplexingEnabled =
  resolveMultiplexingEnabled(loadMultiplexingConfig().enabled) && isTmuxAvailable();

/** The requested session setting. Effective pane use also requires tmux. */
export function isMultiplexingEnabled(): boolean {
  return multiplexingEnabled;
}

export function setMultiplexingEnabled(enabled: boolean): void {
  multiplexingEnabled = enabled;
}

export function isMultiplexingActive(): boolean {
  return multiplexingEnabled && isTmuxAvailable();
}

/** A process-backed surface is always available, even outside tmux. */
export function isMuxAvailable(): boolean {
  return true;
}

export function muxSetupHint(): string {
  return "Start pi inside tmux (`tmux new -A -s pi 'pi'`) or use silent background mode.";
}

function requireTmux(): void {
  if (!isTmuxAvailable()) {
    throw new Error(`tmux is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Pane layout ──

type SubagentLayout = "even-horizontal" | "even-vertical";

/**
 * Pick equal columns for physically square/landscape windows and equal rows
 * for portrait windows. tmux reports columns and rows, but monospace cells are
 * roughly twice as tall as they are wide, so scale row count before comparing.
 */
export function layoutForDimensions(width: number, height: number): SubagentLayout {
  return width >= height * 2 ? "even-horizontal" : "even-vertical";
}

function windowLayout(target: string): SubagentLayout {
  try {
    const output = execFileSync(
      "tmux",
      ["display-message", "-p", "-t", target, "#{window_width} #{window_height}"],
      { encoding: "utf8" },
    ).trim();
    const [width, height] = output.split(/\s+/).map(Number);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return layoutForDimensions(width, height);
    }
  } catch {
    // Fall back to the historical side-by-side layout if dimensions cannot be read.
  }
  return "even-horizontal";
}

let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-balance subagent panes so repeated splits don't leave them lopsided.
 * tmux halves the target pane on every split and dumps freed space onto a
 * neighbor on close, so without this panes drift to wildly uneven widths.
 * Applies the aspect-ratio-selected layout to the parent pi window. Debounced
 * so a burst of parallel spawns or staggered exits collapses into one call,
 * and non-fatal: a cosmetic resize must never break spawning or watching.
 */
function rebalanceSurfaces(hintPane?: string): void {
  // Prefer the parent pi pane (stable; survives a closing subagent pane).
  const target = process.env.TMUX_PANE ?? hintPane;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try {
      // -t <pane> resolves to that pane's window; does not change focus.
      const layout = windowLayout(target);
      execFileSync("tmux", ["select-layout", "-t", target, layout], {
        encoding: "utf8",
      });
    } catch {
      // Pane/window may be gone; balancing is best-effort.
    }
  }, 120);
}

// ── Surface primitives ──

interface BackgroundSurface {
  child: ChildProcess | null;
  exitCode: number | null;
  logPath: string;
  sessionFile?: string;
}

const backgroundSurfaces = new Map<string, BackgroundSurface>();

function isBackgroundSurface(surface: string): boolean {
  return surface.startsWith("bg:");
}

/**
 * Create a pane when multiplexing is active, otherwise allocate a process
 * surface. Process surfaces are launched by sendLongCommand once its script
 * has been written.
 */
export function createSurface(
  name: string,
  options?: { id?: string; logPath?: string; sessionFile?: string },
): string {
  if (!isMultiplexingActive()) {
    const id = options?.id ?? `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const surface = `bg:${id}`;
    const logPath = options?.logPath ?? join(tmpdir(), "pi-subagent-logs", `${name}-${id}.log`);
    mkdirSync(dirname(logPath), { recursive: true });
    backgroundSurfaces.set(surface, { child: null, exitCode: null, logPath, sessionFile: options?.sessionFile });
    return surface;
  }
  const target = process.env.TMUX_PANE;
  const direction = target && windowLayout(target) === "even-vertical" ? "down" : "right";
  return createSurfaceSplit(name, direction, target);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns the new pane id (e.g. `%12`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireTmux();

  const args = ["split-window", "-d"];
  if (direction === "left" || direction === "right") {
    args.push("-h");
  } else {
    args.push("-v");
  }
  if (direction === "left" || direction === "up") {
    args.push("-b");
  }
  if (fromSurface) {
    args.push("-t", fromSurface);
  }
  args.push("-P", "-F", "#{pane_id}");

  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) {
    throw new Error(`Unexpected tmux split-window output: ${pane}`);
  }

  rebalanceSurfaces(pane);
  return pane;
}

/**
 * Send a command string to a pane and execute it.
 * Typed literally (`-l`) so special characters are not interpreted as keys,
 * then submitted with Enter.
 */
export function sendCommand(
  surface: string,
  command: string,
  options?: { sessionFile?: string },
): void {
  if (isBackgroundSurface(surface)) {
    const record = backgroundSurfaces.get(surface);
    const sessionFile = options?.sessionFile ?? record?.sessionFile;
    if (sessionFile) {
      writeFileSync(`${sessionFile}.steer`, command + "\n", "utf8");
    }
    return;
  }
  requireTmux();
  if (options?.sessionFile) {
    try {
      writeFileSync(`${options.sessionFile}.steer`, command + "\n", "utf8");
    } catch {}
  }
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { encoding: "utf8" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * This avoids terminal line-wrapping issues that break commands exceeding the
 * pane's column width when sent character-by-character via sendCommand.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });

  if (isBackgroundSurface(surface)) {
    const record = backgroundSurfaces.get(surface);
    if (!record) throw new Error(`Unknown background surface: ${surface}`);
    const logFd = openSync(record.logPath, "a");
    const child = spawn("bash", [scriptPath], {
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);
    record.child = child;
    child.once("exit", (code) => {
      record.exitCode = code ?? 1;
    });
    child.once("error", (error) => {
      record.exitCode = 1;
      try {
        writeFileSync(record.logPath, `Failed to launch background subagent: ${error.message}\n`, { flag: "a" });
      } catch {}
    });
  } else {
    sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  }
  return scriptPath;
}

/**
 * Read the screen contents of a pane (sync), joining terminal-wrapped rows so
 * callers can match logical output even when a pane is narrow.
 */
export function readScreen(surface: string, lines = 50): string {
  if (isBackgroundSurface(surface)) {
    const record = backgroundSurfaces.get(surface);
    if (!record || !existsSync(record.logPath)) return "";
    return readFileSync(record.logPath, "utf8").split("\n").slice(-Math.max(1, lines) - 1).join("\n");
  }
  requireTmux();
  return execFileSync(
    "tmux",
    ["capture-pane", "-p", "-J", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    {
      encoding: "utf8",
    },
  );
}

/**
 * Read the screen contents of a pane (async), joining terminal-wrapped rows.
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  if (isBackgroundSurface(surface)) return readScreen(surface, lines);
  requireTmux();
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-p", "-J", "-t", surface, "-S", `-${Math.max(1, lines)}`],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  if (isBackgroundSurface(surface)) {
    const record = backgroundSurfaces.get(surface);
    if (record?.child && record.exitCode === null && record.child.exitCode === null) {
      record.child.kill("SIGTERM");
    }
    backgroundSurfaces.delete(surface);
    return;
  }
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { encoding: "utf8" });
  rebalanceSurfaces();
}

export function getBackgroundSurfaceLogPath(surface: string): string | undefined {
  return backgroundSurfaces.get(surface)?.logPath;
}

export function closeAllBackgroundSurfaces(): void {
  for (const surface of [...backgroundSurfaces.keys()]) closeSurface(surface);
}

// ── Exit polling ──

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

export const __pollForExitTest__ = { interpretExitSidecar };

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: {
    interval: number;
    sessionFile?: string;
    sentinelFile?: string;
    onTick?: (elapsed: number) => void;
  },
): Promise<PollResult> {
  const start = Date.now();

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (options.sessionFile) {
      try {
        const exitFile = `${options.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (options.sentinelFile) {
      try {
        if (existsSync(options.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal/log output for the shell sentinel.
    try {
      const screen = await readScreenAsync(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (options.sessionFile) {
        try {
          const exitFile = `${options.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    // A background child can terminate before writing any sidecar or sentinel
    // (for example, if bash itself cannot start the command).
    if (isBackgroundSurface(surface)) {
      const record = backgroundSurfaces.get(surface);
      const exitCode = record?.exitCode ?? record?.child?.exitCode;
      if (exitCode !== null && exitCode !== undefined) {
        return { reason: "sentinel", exitCode };
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
