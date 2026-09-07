import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const HERDR_CLI_TIMEOUT_MS = 5_000;
const ownedPanes = new Set<string>();

export class HerdrCliError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

function parseErrorPayload(text: string): { code?: string; message?: string } {
  try {
    const value = JSON.parse(text);
    const error = value?.error;
    return error && typeof error === "object"
      ? { code: typeof error.code === "string" ? error.code : undefined, message: typeof error.message === "string" ? error.message : undefined }
      : {};
  } catch { return {}; }
}

async function execHerdr(args: string[], operation: string, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execFileAsync("herdr", args, {
      encoding: "utf8", timeout: HERDR_CLI_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, signal,
    });
    return stdout;
  } catch (error: any) {
    const stderr = String(error?.stderr ?? "").trim();
    const stdout = String(error?.stdout ?? "").trim();
    const parsed = parseErrorPayload(stderr) || parseErrorPayload(stdout);
    const message = parsed.message ?? stderr ?? stdout ?? error?.message ?? String(error);
    throw new HerdrCliError(`Herdr ${operation} failed: ${message}`, parsed.code);
  }
}

async function json(args: string[], operation: string, signal?: AbortSignal): Promise<any> {
  const stdout = await execHerdr(args, operation, signal);
  let value: any;
  try { value = JSON.parse(stdout); } catch { throw new HerdrCliError(`Herdr ${operation} returned invalid JSON: ${stdout.slice(0, 300)}`); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.error != null || !("result" in value)) {
    const parsed = parseErrorPayload(stdout);
    throw new HerdrCliError(`Herdr ${operation} returned an error response: ${JSON.stringify(value).slice(0, 500)}`, parsed.code);
  }
  return value;
}

export function isHerdrCliInstalled(): boolean {
  try { execFileSync("sh", ["-c", "command -v herdr"], { stdio: "ignore" }); return true; } catch { return false; }
}

export function isHerdrEnvironment(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID;
}

export async function createHerdrPane(parent: string, direction: "right" | "down", signal?: AbortSignal): Promise<string> {
  const response = await json(["pane", "split", parent, "--direction", direction, "--no-focus"], "pane split", signal);
  const pane = response.result?.pane?.pane_id;
  if (typeof pane !== "string" || !pane) throw new HerdrCliError("Herdr pane split response omitted result.pane.pane_id");
  ownedPanes.add(pane);
  return pane;
}

export async function runHerdrCommand(pane: string, command: string, signal?: AbortSignal): Promise<void> {
  await execHerdr(["pane", "run", pane, command], "pane run", signal);
}

export async function sendHerdrMessage(pane: string, message: string, signal?: AbortSignal): Promise<void> {
  await execHerdr(["pane", "send-text", pane, message], "pane send-text", signal);
  await execHerdr(["pane", "send-keys", pane, "enter"], "pane send-keys", signal);
}

export function getRecentOwnedHerdrPane(): string | undefined {
  const arr = Array.from(ownedPanes);
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

export async function getHerdrPaneDimensions(pane: string, signal?: AbortSignal): Promise<{ width: number; height: number } | null> {
  try {
    const res = await json(["pane", "layout", "--pane", pane], "pane layout", signal);
    const p = res?.result?.layout?.panes?.find((item: any) => item.pane_id === pane);
    if (p?.rect?.width && p?.rect?.height) {
      return { width: Number(p.rect.width), height: Number(p.rect.height) };
    }
  } catch {}
  return null;
}

export function getRecommendedHerdrDirection(width: number, height: number): "right" | "down" {
  return width >= height * 2 ? "right" : "down";
}

export async function readHerdrPane(pane: string, lines: number, signal?: AbortSignal): Promise<string> {
  const args = ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", String(Math.max(1, lines))];
  const recent = await execHerdr(args, "pane read", signal);
  return recent || execHerdr(["pane", "read", pane, "--source", "visible", "--lines", String(Math.max(1, lines))], "pane read visible", signal);
}

export async function probeHerdrPane(pane: string, signal?: AbortSignal): Promise<"exists" | "missing"> {
  try {
    const response = await json(["pane", "get", pane], "pane get", signal);
    if (response.result?.pane?.pane_id !== pane) throw new HerdrCliError("Herdr pane get response omitted or mismatched result.pane.pane_id");
    return "exists";
  } catch (error) {
    if (error instanceof HerdrCliError && (error.code === "pane_not_found" || error.code === "not_found")) return "missing";
    throw error;
  }
}

export async function closeHerdrPane(pane: string, signal?: AbortSignal): Promise<void> {
  if (!ownedPanes.has(pane)) return;
  try {
    await json(["pane", "close", pane], "pane close", signal);
    ownedPanes.delete(pane);
  } catch (error) {
    if (error instanceof HerdrCliError && (error.code === "pane_not_found" || error.code === "not_found")) {
      ownedPanes.delete(pane);
      return;
    }
    // Keep ownership so a later shutdown/retry can close the pane.
    throw error;
  }
}

export const __herdrTest__ = { ownedPanes, parseErrorPayload };
