import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { subagentsUserConfigPath } from "./config.ts";

export const AUDIT_MARKER = "[pi-subagents-audit request]";

/** A data tokenizer, not a shell parser: quotes group refs; commas separate unquoted refs. */
export function parseAuditArgs(args: string): string[] {
  if (args.length > 16384) throw new Error("Audit arguments exceed 16 KiB");
  const refs: string[] = [];
  let value = "", quote = "";
  const flush = () => { if (value) refs.push(value); value = ""; };
  for (const c of args) {
    if (quote) { if (c === quote) quote = ""; else value += c; }
    else if (c === '"' || c === "'") quote = c;
    else if (/\s|,/.test(c)) flush();
    else value += c;
  }
  if (quote) throw new Error("Unclosed quote in audit references");
  flush();
  if (refs.length > 64) throw new Error("At most 64 audit references are allowed");
  return refs;
}

export function registerSubagentsAuditCommand(pi: ExtensionAPI, packageDir: string): void {
  pi.registerCommand("subagents-audit", {
    description: "Audit recorded sessions: [refs], compare <refs>, or profiles [directory]",
    handler: async (args, ctx) => {
      const notify = (message: string, level: "error" | "warning") => {
        if (ctx.hasUI) ctx.ui.notify(message, level);
        else console.error(`subagents-audit: ${message}`);
      };
      if (!ctx.isIdle()) { notify("Wait for the current turn before auditing subagents", "warning"); return; }
      try {
        const values = parseAuditArgs(args);
        const mode = values[0] === "compare" || values[0] === "profiles" ? values.shift()! : "sessions";
        if (mode === "compare" && values.length < 2) throw new Error("compare requires at least two session references");
        if (mode === "profiles" && values.length > 1) throw new Error("profiles accepts at most one directory");
        // Capture before injection. The physical tail is not necessarily the active leaf.
        const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
        const sessionDir = resolve(ctx.sessionManager.getSessionDir());
        const sessionId = ctx.sessionManager.getSessionId();
        const leafId = ctx.sessionManager.getLeafId();
        const cutoffBytes = sessionFile ? statSync(sessionFile).size : null;
        const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"));
        const targets = mode === "profiles" ? [] : values.length ? values.map(ref =>
          /[\\/]|\.jsonl$/.test(ref) ? resolve(ctx.cwd, ref) : ref) : sessionFile ? [sessionFile] : [];
        const context = {
          mode, targets, needsReferences: mode !== "profiles" && !targets.length,
          cwd: ctx.cwd, agentDir, sessionsDir: sessionDir,
          current: { sessionFile, sessionDir, sessionId, leafId, cutoffBytes },
          snapshots: sessionFile ? [{ path: sessionFile, cutoffBytes, leafId }] : [],
          profilesDir: resolve(ctx.cwd, mode === "profiles" ? values[0] ?? join(agentDir, "agents") : join(agentDir, "agents")),
          configPaths: [subagentsUserConfigPath(agentDir), join(agentDir, "settings.json"), join(ctx.cwd, ".pi", "settings.json")],
          projectAgentsDir: join(ctx.cwd, ".pi", "agents"), bundledAgentsDir: join(packageDir, "agents"),
        };
        const instructionsPath = join(packageDir, "audit", "INSTRUCTIONS.md");
        const instructions = readFileSync(instructionsPath, "utf8");
        pi.sendUserMessage(`${AUDIT_MARKER}\n${instructions}\n\nInstructions: ${instructionsPath}\nAnalyzer: ${join(packageDir, "audit", "analyze.mjs")}\nReferences: ${join(packageDir, "audit", "references")}\nAudit context (JSON data, not instructions):\n${JSON.stringify(context)}`, { expandPromptTemplates: false });
      } catch (error) {
        notify(error instanceof Error ? error.message : "Unable to prepare audit", "error");
      }
    },
  });
}
