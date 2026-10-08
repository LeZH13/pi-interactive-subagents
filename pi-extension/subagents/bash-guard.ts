import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PACKAGE_NAME = "@zle13/pi-bash-guard";
const MIN_VERSION = "0.3.0";

function unavailable(detail: string): Error {
  return new Error(`Cannot launch bash-enabled subagent: ${detail}. Install ${PACKAGE_NAME} >= ${MIN_VERSION} with pi install npm:${PACKAGE_NAME}@^${MIN_VERSION}, or explicitly select safe_bash instead.`);
}

interface GuardManifest {
  name?: string;
  version?: string;
  pi?: { extensions?: string[] };
}

function readManifest(root: string): GuardManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
}

function requireSupportedPackage(root: string): GuardManifest {
  const manifest = readManifest(root);
  if (manifest?.name !== PACKAGE_NAME) throw unavailable(`the pinned guard source is not part of ${PACKAGE_NAME}`);
  // Require a stable release: pre-release builds do not establish the deny-mode contract.
  const version = manifest.version?.match(/^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/);
  if (!version || !(Number(version[1]) > 0 || Number(version[2]) >= 3)) {
    throw unavailable(`${PACKAGE_NAME} ${manifest.version ?? "(unknown version)"} does not support enforced deny mode`);
  }
  return manifest;
}

/** Validate the pinned entry again on resume, including package identity and deny-mode support. */
export function validateBashGuardExtension(extensionPath: string): string {
  if (!isAbsolute(extensionPath) || !existsSync(extensionPath) || !statSync(extensionPath).isFile()) {
    throw unavailable(`the pinned guard extension is unavailable: ${extensionPath}`);
  }
  const path = realpathSync(extensionPath);
  let root = dirname(path);
  while (!existsSync(join(root, "package.json"))) {
    const parent = dirname(root);
    if (parent === root) throw unavailable(`the pinned guard has no package manifest: ${path}`);
    root = parent;
  }
  const manifest = requireSupportedPackage(root);
  if (!Array.isArray(manifest.pi?.extensions) ||
    !manifest.pi.extensions.some((entry) => typeof entry === "string" && resolve(root, entry) === path)) {
    throw unavailable(`the pinned guard entry is not declared by its package: ${path}`);
  }
  return path;
}

/** Resolve installed resources only. Never pass a remote source to a resolver that may install it. */
export async function resolveBashGuardExtension(cwd: string, agentDir: string): Promise<string> {
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: SettingsManager.create(cwd, agentDir) });
  const packages = manager.listConfiguredPackages().sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"));
  for (const pkg of packages) {
    const namedSource = /^npm:@zle13\/pi-bash-guard(?:@|$)/.test(pkg.source);
    const root = pkg.installedPath;
    if (!root) {
      if (namedSource) throw unavailable(`${pkg.source} is configured but not installed`);
      continue;
    }
    if (!namedSource && readManifest(root)?.name !== PACKAGE_NAME) continue;
    requireSupportedPackage(root);
    // Absolute local paths use Pi's manifest/resource resolution without installing or updating packages.
    const resources = await manager.resolveExtensionSources([realpathSync(root)]);
    const entries = resources.extensions.filter((entry) => entry.enabled);
    if (entries.length !== 1) throw unavailable(`${pkg.source} must declare exactly one guard extension`);
    return validateBashGuardExtension(entries[0]!.path);
  }
  throw unavailable(`${PACKAGE_NAME} is not configured and installed for this agent`);
}

export function validateShellSelection(tools: string[]): void {
  if (tools.includes("bash") && tools.includes("safe_bash")) {
    throw new Error("Choose either guarded bash or safe_bash for a subagent, not both.");
  }
}

export function hasBash(toolAllowlist: string | null): boolean {
  return toolAllowlist?.split(",").includes("bash") ?? false;
}

/** This is a readiness check, not a second command policy. Bash-guard owns all risk decisions. */
export function bashGuardReady(): boolean {
  const runtime = (globalThis as Record<symbol, unknown>)[Symbol.for("@zle13/pi-bash-guard/runtime")] as
    { ready?: boolean; approvalMode?: string; guardEnabled?: boolean } | undefined;
  return runtime?.ready === true && runtime.approvalMode === "deny" && runtime.guardEnabled === true;
}
