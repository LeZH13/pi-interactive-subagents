import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Installed local package fixture; no network or real shell execution. */
export function createGuardPackage(directory: string, version = "0.3.0") {
  const root = join(directory, "bash-guard");
  const extension = join(root, "extensions", "index.ts");
  mkdirSync(join(root, "extensions"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({
    name: "@zle13/pi-bash-guard", version, pi: { extensions: ["./extensions/index.ts"] },
  }));
  writeFileSync(extension, "export default () => {};\n");
  return { root, extension };
}

export function configureGuard(agentDir: string, root: string) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [root] }));
}
