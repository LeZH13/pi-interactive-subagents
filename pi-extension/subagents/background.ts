import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface BackgroundSurface { child: ChildProcess | null; exitCode: number | null; logPath: string; }
const surfaces = new Map<string, BackgroundSurface>();

export function createBackgroundSurface(id: string, logPath: string): string {
  mkdirSync(dirname(logPath), { recursive: true });
  const surface = `bg:${id}`;
  surfaces.set(surface, { child: null, exitCode: null, logPath });
  return surface;
}

export function launchBackground(surface: string, scriptPath: string): void {
  const record = surfaces.get(surface);
  if (!record) throw new Error(`Unknown background surface: ${surface}`);
  const fd = openSync(record.logPath, "a");
  const child = spawn("bash", [scriptPath], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  record.child = child;
  child.once("exit", (code) => { record.exitCode = code ?? 1; });
  child.once("error", (error) => {
    record.exitCode = 1;
    try { writeFileSync(record.logPath, `Failed to launch background subagent: ${error.message}\n`, { flag: "a" }); } catch {}
  });
}

export function readBackground(surface: string, lines: number): string {
  const record = surfaces.get(surface);
  if (!record || !existsSync(record.logPath)) return "";
  return readFileSync(record.logPath, "utf8").split("\n").slice(-Math.max(1, lines) - 1).join("\n");
}

export function backgroundExitCode(surface: string): number | null | undefined {
  const record = surfaces.get(surface);
  return record?.exitCode ?? record?.child?.exitCode;
}
export function hasBackgroundSurface(surface: string): boolean { return surfaces.has(surface); }
export function backgroundLogPath(surface: string): string | undefined { return surfaces.get(surface)?.logPath; }
export function closeBackground(surface: string): void {
  const record = surfaces.get(surface);
  if (record?.child && record.exitCode === null && record.child.exitCode === null) record.child.kill("SIGTERM");
  surfaces.delete(surface);
}
export function allBackgroundSurfaces(): string[] { return [...surfaces.keys()]; }
