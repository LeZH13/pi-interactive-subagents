/** Backend-neutral, async surface contract and facade. */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as tmux from "./tmux.ts";
import { allBackgroundSurfaces, backgroundExitCode, backgroundLogPath, closeBackground, createBackgroundSurface, hasBackgroundSurface, launchBackground, readBackground } from "./background.ts";
import { HERDR_CLI_TIMEOUT_MS, HerdrCliError, closeHerdrPane, createHerdrPane, getHerdrPaneDimensions, getRecentOwnedHerdrPane, getRecommendedHerdrDirection, isHerdrCliInstalled, isHerdrEnvironment, probeHerdrPane, readHerdrPane, runHerdrCommand, sendHerdrMessage } from "./herdr.ts";

export type SurfaceBackendKind = "auto" | "tmux" | "herdr" | "background";
export interface MultiplexingConfig { enabled: boolean; backend: SurfaceBackendKind; }
export interface PollResult { reason: "done" | "sentinel" | "error"; exitCode: number; errorMessage?: string; }
export interface SurfaceBackend {
  readonly kind: Exclude<SurfaceBackendKind, "auto">;
  create(name: string, options?: SurfaceOptions): Promise<string>;
  run(surface: string, command: string): Promise<void>;
  sendMessage(surface: string, message: string): Promise<void>;
  read(surface: string, lines: number, signal?: AbortSignal): Promise<string>;
  close(surface: string, signal?: AbortSignal): Promise<void>;
}
export interface SurfaceOptions { id?: string; logPath?: string; sessionFile?: string; }

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_CONFIG_PATH = join(PACKAGE_ROOT, "config.json");
const EXAMPLE_CONFIG_PATH = join(PACKAGE_ROOT, "config.json.example");
export function parseMultiplexingConfig(raw: unknown, source = "config.json"): MultiplexingConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Invalid subagent multiplexing config in ${source}: root must be an object`);
  const multiplexing = (raw as any).multiplexing;
  if (multiplexing === undefined) return { enabled: true, backend: "auto" };
  if (!multiplexing || typeof multiplexing !== "object" || Array.isArray(multiplexing)) throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing must be an object`);
  const unsupported = Object.keys(multiplexing).filter((key) => key !== "enabled" && key !== "backend");
  if (unsupported.length) throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing has unsupported key(s): ${unsupported.join(", ")}`);
  const enabled = multiplexing.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing.enabled must be a boolean`);
  const backend = multiplexing.backend ?? (enabled ? "auto" : "background");
  if (!["auto", "tmux", "herdr", "background"].includes(backend)) throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing.backend must be auto, tmux, herdr, or background`);
  if (!enabled && multiplexing.backend !== undefined && backend !== "background") throw new Error(`Invalid subagent multiplexing config in ${source}: multiplexing.enabled=false conflicts with backend=${backend}`);
  return { enabled, backend };
}
export function loadMultiplexingConfig(configPath = DEFAULT_CONFIG_PATH, examplePath = EXAMPLE_CONFIG_PATH): MultiplexingConfig {
  let source = configPath; let raw: string;
  try { raw = readFileSync(configPath, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    source = examplePath; raw = readFileSync(examplePath, "utf8");
  }
  try { return parseMultiplexingConfig(JSON.parse(raw), source); } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in subagent config ${source}: ${error.message}`);
    throw error;
  }
}
export function resolveMultiplexingEnabled(configured: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PI_SUBAGENT_DISABLE_TMUX === "1" || env.PI_SUBAGENT_MULTIPLEX === "0") return false;
  if (env.PI_SUBAGENT_MULTIPLEX === "1") return true;
  return configured;
}
const loaded = loadMultiplexingConfig();
let preference: SurfaceBackendKind = process.env.PI_SUBAGENT_DISABLE_TMUX === "1" ? "background"
  : (process.env.PI_SUBAGENT_BACKEND as SurfaceBackendKind | undefined)
    ?? (process.env.PI_SUBAGENT_MULTIPLEX === "0" ? "background" : process.env.PI_SUBAGENT_MULTIPLEX === "1" ? "auto" : loaded.backend);
function validBackend(value: unknown): value is SurfaceBackendKind { return typeof value === "string" && ["auto", "tmux", "herdr", "background"].includes(value); }
if (!validBackend(preference)) throw new Error(`Invalid PI_SUBAGENT_BACKEND=${preference}; expected auto, tmux, herdr, or background`);
export function resolveSurfaceBackend(requested: SurfaceBackendKind = preference, env: NodeJS.ProcessEnv = process.env, availability: { tmux?: boolean; herdr?: boolean } = {}): Exclude<SurfaceBackendKind, "auto"> {
  if (env.PI_SUBAGENT_DISABLE_TMUX === "1") return "background";
  if (requested !== "auto") return requested;
  const inTmuxEnv = !!env.TMUX; const inHerdrEnv = isHerdrEnvironment(env);
  if (inTmuxEnv && inHerdrEnv) throw new Error("Ambiguous nested terminal environment: both tmux and Herdr are active. Set multiplexing.backend or PI_SUBAGENT_BACKEND explicitly.");
  if (inHerdrEnv && (availability.herdr ?? isHerdrCliInstalled())) return "herdr";
  if (inTmuxEnv && (availability.tmux ?? tmux.isTmuxAvailable())) return "tmux";
  return "background";
}
export function getSurfaceBackendPreference(): SurfaceBackendKind { return process.env.PI_SUBAGENT_DISABLE_TMUX === "1" ? "background" : preference; }
export function setSurfaceBackendPreference(value: SurfaceBackendKind): void { preference = process.env.PI_SUBAGENT_DISABLE_TMUX === "1" ? "background" : value; }
export function isMultiplexingEnabled(): boolean { return getSurfaceBackendPreference() !== "background"; }
export function setMultiplexingEnabled(enabled: boolean): void { setSurfaceBackendPreference(enabled ? "auto" : "background"); }
export function isMultiplexingActive(): boolean { return resolveSurfaceBackend() !== "background"; }
export function isMuxAvailable(): boolean { return true; }
export function isTmuxAvailable(): boolean { return tmux.isTmuxAvailable(); }
export function isHerdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean { return isHerdrEnvironment(env) && isHerdrCliInstalled(); }
export function muxSetupHint(): string { return "Run pi inside tmux or Herdr, or select backend=background."; }
export const shellEscape = tmux.shellEscape;
export const layoutForDimensions = tmux.layoutForDimensions;

function kind(surface: string): Exclude<SurfaceBackendKind, "auto"> { return surface.startsWith("bg:") ? "background" : surface.startsWith("herdr:") ? "herdr" : "tmux"; }
function pane(surface: string): string { return surface.slice("herdr:".length); }
export const getSurfaceBackend = kind;

export async function createSurface(name: string, options: SurfaceOptions = {}): Promise<string> {
  const selected = resolveSurfaceBackend();
  if (selected === "background") {
    const id = options.id ?? `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    return createBackgroundSurface(id, options.logPath ?? join(tmpdir(), "pi-subagent-logs", `${name}-${id}.log`));
  }
  if (selected === "herdr") {
    if (!isHerdrAvailable()) throw new Error(`Herdr backend requested but HERDR_ENV=1, HERDR_PANE_ID, and the herdr CLI are required. ${muxSetupHint()}`);
    const recent = getRecentOwnedHerdrPane();
    if (!recent) {
      return `herdr:${await createHerdrPane(process.env.HERDR_PANE_ID!, "right")}`;
    }
    const dims = await getHerdrPaneDimensions(recent);
    const direction = dims ? getRecommendedHerdrDirection(dims.width, dims.height) : "down";
    return `herdr:${await createHerdrPane(recent, direction)}`;
  }
  if (!tmux.isTmuxAvailable()) throw new Error(`tmux backend requested but unavailable. ${muxSetupHint()}`);
  return tmux.createSurface(name);
}
export async function createSurfaceSplit(name: string, direction: "left" | "right" | "up" | "down", from?: string): Promise<string> {
  if (resolveSurfaceBackend() === "herdr") {
    if (direction === "left" || direction === "up") throw new Error("Herdr supports right/down splits only");
    const parent = from?.startsWith("herdr:") ? pane(from) : from ?? process.env.HERDR_PANE_ID;
    if (!parent) throw new Error("Herdr split requires an explicit parent HERDR_PANE_ID");
    return `herdr:${await createHerdrPane(parent, direction)}`;
  }
  return tmux.createSurfaceSplit(name, direction, from);
}
export async function sendCommand(surface: string, command: string): Promise<void> {
  if (kind(surface) === "background") return;
  if (kind(surface) === "herdr") return runHerdrCommand(pane(surface), command);
  tmux.sendCommand(surface, command);
}
export async function sendTerminalMessage(surface: string, message: string): Promise<void> {
  if (kind(surface) === "background") throw new Error("Cannot inject terminal input into a background surface");
  if (kind(surface) === "herdr") return sendHerdrMessage(pane(surface), message);
  tmux.sendTerminalMessage(surface, message);
}
export async function sendLongCommand(surface: string, command: string, options?: { scriptPath?: string; scriptPreamble?: string }): Promise<string> {
  const scriptPath = options?.scriptPath ?? join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, ["#!/bin/bash", options?.scriptPreamble?.trimEnd(), command].filter(Boolean).join("\n") + "\n", { mode: 0o755 });
  if (kind(surface) === "background") launchBackground(surface, scriptPath); else await sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}
export async function readScreenAsync(surface: string, lines = 50, signal?: AbortSignal): Promise<string> {
  if (kind(surface) === "background") return readBackground(surface, lines);
  if (kind(surface) === "herdr") return readHerdrPane(pane(surface), lines, signal);
  return tmux.readScreenAsync(surface, lines, signal);
}
export async function readScreen(surface: string, lines = 50): Promise<string> { return readScreenAsync(surface, lines); }
export async function closeSurface(surface: string, signal?: AbortSignal): Promise<void> {
  if (kind(surface) === "background") return closeBackground(surface);
  if (kind(surface) === "herdr") return closeHerdrPane(pane(surface), signal);
  tmux.closeSurface(surface);
}
export function getBackgroundSurfaceLogPath(surface: string): string | undefined { return backgroundLogPath(surface); }
export async function closeAllBackgroundSurfaces(): Promise<void> { await Promise.allSettled(allBackgroundSurfaces().map((s) => closeSurface(s))); }

function interpretExit(data: any): PollResult {
  if (data?.type === "error") return { reason: "error", exitCode: 1, errorMessage: typeof data.errorMessage === "string" && data.errorMessage.trim() ? data.errorMessage : "Subagent exited with stopReason=error (no errorMessage in sidecar)." };
  return { reason: "done", exitCode: 0 };
}
export const __pollForExitTest__ = { interpretExitSidecar: interpretExit };
export const __surfaceTest__ = { cliTimeoutMs: HERDR_CLI_TIMEOUT_MS, resetCommandAvailability() {} };
export async function pollForExit(surface: string, signal: AbortSignal, options: { interval: number; sessionFile?: string; sentinelFile?: string; runId?: string; startedAt?: number; completionFile?: string; onTick?: (elapsed: number) => void }): Promise<PollResult> {
  const startedAt = options.startedAt ?? Date.now(); let failures = 0;
  for (;;) {
    if (signal.aborted) throw new Error("Aborted while waiting for subagent to finish");
    if (options.runId && options.completionFile) {
      try {
        const done = JSON.parse(readFileSync(options.completionFile, "utf8"));
        if (done?.type === "completion" && done.runId === options.runId && done.completedAt >= startedAt && Number.isInteger(done.exitCode)) {
          let result: PollResult = { reason: "done", exitCode: done.exitCode };
          if (options.sessionFile) try {
            const failure = JSON.parse(readFileSync(`${options.sessionFile}.exit`, "utf8"));
            if (failure?.runId === options.runId && failure.createdAt >= startedAt) result = interpretExit(failure);
          } catch {}
          rmSync(options.completionFile, { force: true });
          if (options.sessionFile) rmSync(`${options.sessionFile}.exit`, { force: true });
          return result;
        }
      } catch {}
    } else if (options.sessionFile && existsSync(`${options.sessionFile}.exit`)) {
      try { const data = JSON.parse(readFileSync(`${options.sessionFile}.exit`, "utf8")); rmSync(`${options.sessionFile}.exit`, { force: true }); return interpretExit(data); } catch {}
    }
    if (options.sentinelFile && existsSync(options.sentinelFile)) return { reason: "sentinel", exitCode: 0 };
    try {
      const output = await readScreenAsync(surface, 5, signal); failures = 0;
      const match = output.match(/__SUBAGENT_DONE_(\d+)__/); if (match) return { reason: "sentinel", exitCode: Number(match[1]) };
    } catch (error: any) {
      failures++;
      if (kind(surface) === "herdr") {
        try { const state = await probeHerdrPane(pane(surface), signal); if (state === "exists") failures = 0; }
        catch {}
      } else if (kind(surface) === "tmux" && await tmux.probeTmux(surface, signal)) failures = 0;
      if (failures >= 3) return { reason: "error", exitCode: 1, errorMessage: `${kind(surface)} pane/backend unavailable for 3 consecutive probes: ${error?.message ?? error}` };
    }
    if (kind(surface) === "background") {
      const code = backgroundExitCode(surface);
      if (code !== null && code !== undefined) return { reason: "sentinel", exitCode: code };
      if (!hasBackgroundSurface(surface) && ++failures >= 3) return { reason: "error", exitCode: 1, errorMessage: "Background subagent surface disappeared before completion." };
    }
    options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, options.interval);
      const abort = () => { clearTimeout(timer); reject(new Error("Aborted")); };
      signal.addEventListener("abort", abort, { once: true });
    });
  }
}
