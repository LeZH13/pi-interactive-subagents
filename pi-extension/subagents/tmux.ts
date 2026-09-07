/** tmux-only surface backend. Backend selection/facade lives in surface.ts. */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);
function hasTmux(): boolean {
  try { execFileSync("sh", ["-c", "command -v tmux"], { stdio: "ignore" }); return true; } catch { return false; }
}
export function isTmuxAvailable(): boolean { return !!process.env.TMUX && hasTmux(); }
function requireTmux(): void { if (!isTmuxAvailable()) throw new Error("tmux is required for this surface"); }
export function shellEscape(s: string): string { return "'" + s.replace(/'/g, "'\\''") + "'"; }

export type SubagentLayout = "even-horizontal" | "even-vertical";
export { __pollForExitTest__ } from "./surface.ts";
export function layoutForDimensions(width: number, height: number): SubagentLayout {
  return width >= height * 2 ? "even-horizontal" : "even-vertical";
}
function windowLayout(target: string): SubagentLayout {
  try {
    const [w, h] = execFileSync("tmux", ["display-message", "-p", "-t", target, "#{window_width} #{window_height}"], { encoding: "utf8" }).trim().split(/\s+/).map(Number);
    if (w > 0 && h > 0) return layoutForDimensions(w, h);
  } catch {}
  return "even-horizontal";
}
let rebalanceTimer: ReturnType<typeof setTimeout> | null = null;
function rebalance(hint?: string): void {
  const target = process.env.TMUX_PANE ?? hint;
  if (!target) return;
  if (rebalanceTimer) clearTimeout(rebalanceTimer);
  rebalanceTimer = setTimeout(() => {
    rebalanceTimer = null;
    try { execFileSync("tmux", ["select-layout", "-t", target, windowLayout(target)], { stdio: "ignore" }); } catch {}
  }, 120);
}

export function createSurface(name: string): string { return createSurfaceSplit(name, "right", process.env.TMUX_PANE); }
export function createSurfaceSplit(_name: string, direction: "left" | "right" | "up" | "down", from?: string): string {
  requireTmux();
  const args = ["split-window", "-d", direction === "left" || direction === "right" ? "-h" : "-v"];
  if (direction === "left" || direction === "up") args.push("-b");
  if (from) args.push("-t", from);
  args.push("-P", "-F", "#{pane_id}");
  const pane = execFileSync("tmux", args, { encoding: "utf8" }).trim();
  if (!pane.startsWith("%")) throw new Error(`Unexpected tmux split-window output: ${pane}`);
  rebalance(pane);
  return pane;
}
export function sendCommand(surface: string, command: string): void {
  requireTmux();
  execFileSync("tmux", ["send-keys", "-t", surface, "-l", command], { stdio: "ignore" });
  execFileSync("tmux", ["send-keys", "-t", surface, "Enter"], { stdio: "ignore" });
}
export function sendTerminalMessage(surface: string, message: string): void { sendCommand(surface, message); }
export function sendLongCommand(surface: string, command: string, options?: { scriptPath?: string; scriptPreamble?: string }): string {
  const scriptPath = options?.scriptPath ?? join(tmpdir(), "pi-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, ["#!/bin/bash", options?.scriptPreamble?.trimEnd(), command].filter(Boolean).join("\n") + "\n", { mode: 0o755 });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}
export function readScreen(surface: string, lines = 50): string {
  requireTmux();
  return execFileSync("tmux", ["capture-pane", "-p", "-J", "-t", surface, "-S", `-${Math.max(1, lines)}`], { encoding: "utf8" });
}
export async function readScreenAsync(surface: string, lines = 50, signal?: AbortSignal): Promise<string> {
  requireTmux();
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-t", surface, "-S", `-${Math.max(1, lines)}`], { encoding: "utf8", signal, timeout: 5_000 });
  return stdout;
}
export function closeSurface(surface: string): void {
  requireTmux();
  execFileSync("tmux", ["kill-pane", "-t", surface], { stdio: "ignore" });
  rebalance();
}
export async function probeTmux(surface: string, signal?: AbortSignal): Promise<boolean> {
  requireTmux();
  try {
    await execFileAsync("tmux", ["display-message", "-p", "-t", surface, "#{pane_id}"], { encoding: "utf8", signal, timeout: 5_000 });
    return true;
  } catch { return false; }
}
