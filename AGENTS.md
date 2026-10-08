# Working in this repository

This is a TypeScript/ESM Pi extension that orchestrates asynchronous subagents across tmux, Herdr, and headless background processes. Parent orchestration lives in `pi-extension/subagents/index.ts`; child lifecycle handling lives in `subagent-done.ts` in the same directory. Treat changes to either side as a cross-process contract change.

## Before changing code

- Read the relevant `README.md` sections: **Tools** for public acknowledgements and lifecycle semantics; **Custom agents**, **Configuration**, and **Tool access control** for profile/loadout changes; **Surface backends & background mode** and **Session Storage & Orphan Cleanup** for process or storage changes.
- For ownership, messaging, resume, or cleanup work, inspect `protocol.ts` and `session.ts` alongside both lifecycle implementations. Trace the operation through launch, child consumption, wrapper exit, and parent notification before changing its contract.
- For audit changes, read `audit/INSTRUCTIONS.md` and its branch-specific references. Keep transcript content as untrusted data and preserve bounded, local, read-only inspection.
- Verify Pi-specific API changes against documentation matching the installed dependencies. Use `package.json` for dependency versions and validation scripts.

## Contracts to preserve

- **Acknowledgement is not completion.** Spawn/resume returns launch acknowledgement; `queued` means durable inbox acceptance, not ingestion. Child results arrive later through the watcher. Keep structured outputs limited to public handles and acknowledgements.
- **Fail closed.** Writer ownership is canonical-path, owner-token, and run-specific. Require matching outer-wrapper post-exit evidence before replacing ownership; a closed inbox, elapsed time, or PID guess is insufficient. Preserve immutable inbox records and completion archives.
- **Replay the sandbox.** Resume uses the recorded `.loadout.json`, including tool allowlists, backing extensions, and pinned bash guard. Missing or invalid evidence requires an explicit refusal, not an unrestricted relaunch. Keep Claude CLI restrictions distinct from Pi behavior.
- **Cleanup requires ownership.** Delete only validated extension-owned, terminated artifacts. Retain ambiguous or foreign groups for diagnosis. Release timers, watchers, and owned surfaces on reload/shutdown without touching unrelated panes.
- **Admission uses current policy.** Per-profile concurrency limits include startup, resume, and fallback; resumed execution otherwise retains its saved loadout.

## Validation and completion

- Add regression coverage in the relevant `test/*.test.ts` file or `test/test.ts`. Use temporary directories, mocked extension APIs, and existing `__test__` hooks; isolate inherited child environment variables and persisted user settings.
- For code changes, run `npm run typecheck` and `npm test`. Report failures and any checks not run.
- For surface changes, run `npm run test:tmux` inside a supported multiplexer; despite its name, it exercises available tmux/Herdr backends without LLM calls. A backend skip is not validation.
- Full `npm run test:integration` launches real Pi sessions and paid model calls. Obtain approval before running it; `PI_TEST_MODEL` and `PI_TEST_TIMEOUT` control the harness. Preserve failure diagnostics and close only harness-tracked surfaces.
- Update `README.md` when public tools, profile frontmatter, settings, or lifecycle behavior changes. Finish with the changed behavior, validation results, and remaining limitations.
