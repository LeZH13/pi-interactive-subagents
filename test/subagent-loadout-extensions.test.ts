import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadoutSidecarPath,
  readSubagentLoadout,
  writeSubagentLoadout,
  type SubagentLoadout,
} from "../pi-extension/subagents/session.ts";

const loadout: SubagentLoadout = {
  agent: "worker",
  toolAllowlist: "read,custom_tool,ask_question",
  model: "test/model",
  thinking: "medium",
  systemPromptMode: null,
  identity: null,
  spawnable: null,
  autoExit: false,
  cwd: null,
  agentDir: null,
};

function withSession(run: (sessionFile: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "subagent-extension-snapshot-"));
  try {
    run(join(directory, "child.jsonl"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("loadout backing extension snapshots", () => {
  it("round-trips exact extension entries without resolving them again", () => {
    withSession((sessionFile) => {
      const snapshot = {
        ...loadout,
        toolExtensionPaths: ["/some directory/custom.ts", "builtin:codemode"],
      };
      writeSubagentLoadout(sessionFile, snapshot);
      assert.deepEqual(readSubagentLoadout(sessionFile), snapshot);
    });
  });

  it("preserves an explicitly empty backing-extension list", () => {
    withSession((sessionFile) => {
      writeSubagentLoadout(sessionFile, { ...loadout, toolExtensionPaths: [] });
      assert.deepEqual(readSubagentLoadout(sessionFile)?.toolExtensionPaths, []);
    });
  });

  it("refuses malformed backing-extension entries", () => {
    withSession((sessionFile) => {
      for (const toolExtensionPaths of [null, "custom.ts", [7], [""], ["  "]]) {
        writeFileSync(loadoutSidecarPath(sessionFile), JSON.stringify({ ...loadout, toolExtensionPaths }));
        assert.equal(readSubagentLoadout(sessionFile), null);
      }
    });
  });
});
