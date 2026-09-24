# ROADMAP — maplezzk-improve worktree

**Created:** 2026-09-23 · **Base:** `87040da` (our v3.7.2) · **Status:** plan, nothing implemented yet

This worktree ports proven design choices from the maplezzk fork of
`pi-interactive-subagents` into ours. The document is self-contained: the
research summary below was compiled by reading both codebases, so no session
needs to redo it. Each phase lists its goal, approach, and a checkable
completion criterion. Phases 1–5 are independent enough to land in order but
can be split into separate PRs.

## 1. Background — the two forks

Both projects descend from the same upstream (HazAT / amosblomqvist,
`pi-interactive-subagents`).

- **Ours:** `LeZH13/pi-interactive-subagents`, v3.7.2, standalone repo,
  peerDeps `@mariozechner/pi-coding-agent` ^0.65.
- **Theirs:** `@maplezzk/pi-interactive-subagents` v3.16.2, inside the
  [`maplezzk/pi-extensions`](https://github.com/maplezzk/pi-extensions)
  monorepo (path: `packages/pi-interactive-subagents`), peerDeps
  `@earendil-works/pi-coding-agent` >=0.80 (tested against 0.85.1). Fetch
  source with `pi install git:github.com/maplezzk/pi-extensions` or a plain
  clone; release-please changelog in `CHANGELOG.md` explains why each change
  exists.

### Side-by-side

| Area | Ours (v3.7.2) | maplezzk (v3.16.2) |
| --- | --- | --- |
| Surfaces | Own code: `surface.ts`, `tmux.ts`, `herdr.ts`, `background.ts` (tmux, herdr, headless) | Delegates to the `pi-terminal-mux` npm library: muxy, cmux, tmux, zellij, wezterm, herdr, otty, orca |
| Parent tools | `subagent`, `subagents_list`, `subagent_message` | `subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume` |
| Child tools | `ask_question` (parks session, reply via `subagent_message`); auto-exit at `agent_end` | `caller_ping` (child **exits**, parent resumes with answer); explicit `subagent_done` + nudge if forgotten |
| Child extensions | Derived from `tools` frontmatter; tool→extension map via `registerToolExtension` global | User-curated `subagentExtensions` list, edited via `/config:subagent extensions` toggle chooser |
| Config storage | `/subagent-settings` TUI page → package-local `config.json` | `/config:subagent` slash menu → user dir `~/.pi/agent/extensions/pi-interactive-subagents/config.json` |
| Status | Child snapshot polling + our token/cost telemetry (`StatusTelemetry`) | Child snapshot polling + watchdog (same base design, no telemetry) |
| Workflows | none | `/plan` skill-driven pipeline + 5 bundled agents (planner, scout, worker, reviewer, visual-tester) |
| Interop | `globalThis.__pi_interactive_subagents` → `{ registerToolExtension }` only | Same bridge + `launchSubagent`/`watchSubagent` and `hiddenFromWidget` for orchestrators |
| i18n | none | shared `pi-extensions-i18n` + locales catalog |
| Tests | ~51 blocks | 143 unit + 19 integration (`tsx --test`) |

### Where we are already at parity or ahead

Keep these; the roadmap does not touch them:

- Child-written runtime snapshot status (identical design; we add
  `StatusTelemetry`: model, input/output tokens, cache, cost, context %).
- Watcher robustness: `AbortSignal.any([callerSignal, moduleAbortSignal])`,
  fresh module abort controller installed on `session_start`, aborted on
  `session_shutdown`.
- `--no-extensions` + explicit `-e` child loading, derived per-tool from the
  agent's `tools` list (more precise than their session-wide list).
- Completion reminders suppressed on user abort / provider error.

### What we have that the fork lacks (our differentiators)

`ask_question` (parked-session Q&A, parallel questions) vs their
exit-and-resume ping; name-addressed `subagent_message` with mid-turn
absorption; one-shot model fallback with `inherit` from the immediate
spawner; per-agent thinking levels + `@model:thinking` command syntax;
loadout-snapshot sandboxed resume (`.loadout.json`); headless background
mode; token/cost telemetry; even-pane rebalancing; orphan cleanup;
per-agent spawn whitelists (`subagent_agents`).

## 2. Scope decisions

Decided up front so implementers don't relitigate:

- **Keep auto-exit at `agent_end`.** Do not adopt their explicit
  `subagent_done`-required model. Rationale: their own code comment
  (`subagent-done.ts`) records that the explicit-call model exists because an
  `agent_end` short-circuit prevents harvesting `structuredOutput` from a
  child that never called the tool. We accept that limitation — we don't
  offer structured-output contracts yet (see backlog).
- **Keep `ask_question` parked-session semantics.** Do not adopt
  `caller_ping`'s exit-and-resume flow.
- **Do not adopt i18n / locales.** English-only for now.
- **Do not adopt `pi-terminal-mux` yet** (8 extra backends). Gated on the
  Phase 0 API question; our three backends work today. Revisit after the
  backlog item's gate resolves.
- `spawning: false` frontmatter stays out — our `subagent_agents` whitelist
  already covers child spawning control with finer granularity.

## 3. Phases

### Phase 0 — Runtime API verification (gate, ~small) — ✅ DONE 2026-09-23

Verdict: the `@mariozechner/*` imports were **not** merely stale — the
packages no longer exist on the current pi line (`@mariozechner` is absent
from the global tree), so in a fresh worktree (no `node_modules`) the
extension could not load at all. Migrated everything to
`@earendil-works/pi-coding-agent` / `@earendil-works/pi-tui` at **0.87.1**
(installed pi CLI is 0.87.1):

- `package.json`: peer deps `>=0.87.0`, dev deps pinned 0.87.1, added
  `typescript` + `typecheck` script and a `tsconfig.json` (strict,
  `allowImportingTsExtensions`, noEmit).
- Rewrote all imports in 5 files (`index.ts`, `settings.ts`,
  `subagent-done.ts`, `tools/safe-bash.ts`, `test/test.ts`).
- Fixed every strict-typecheck error; three were **real runtime bugs**:
  1. `activity.ts` — `createNoopRecorder` was missing `syncTelemetry`, so a
     call into it would crash; also `flushNow` needed the `!activityFile`
     guard.
  2. `index.ts` — Claude-path summary extraction called `.replace()` on the
     Promise returned by `readScreen()` (async since the surface refactor):
     `await readScreen(...).replace(...)` → TypeError whenever that fallback
     ran. Now `(await readScreen(...)).replace(...)`.
  3. `harness.ts` — timeout-error path assigned the `readScreen` Promise to
     a string; `.slice()` would have crashed instead of printing the screen.
- 0.87 API drift handled: `Component` now requires `invalidate()` (our three
  message renderers returned bare `{render}` literals — added no-op
  `invalidate`), `Component.handleInput` is optional (`nested.handleInput?.()`),
  `TextContent | ImageContent` union needs `"text" in` narrowing, and
  `Map.get()`/strict-null looseness fixed at 6 more sites (`displayName`
  resolution inside `launchSubagent`, `steerSubagent` Promise return type,
  `removedParents` map type).
- Verified: `npm run typecheck` clean; `npm test` 247/247 pass (51 suites).

Remaining live check (user-side) — ✅ PASSED 2026-09-23: extension loaded in
the installed pi 0.87.1, spawn ran to completion, live widget tracked the
child (labels cycled streaming/tool as designed), completion block rendered.
Phase 0 is fully green; no follow-up items.

Goal (historical): confirm our `@mariozechner` imports (0.65 devDeps) still resolve against
the pi the user actually runs (global install is
`@earendil-works/pi-coding-agent` 0.85.x). Imports currently resolve from the
repo's local `node_modules`, but a version skew against the running pi can
bite subtly (theme API, TUI components).

Approach: load the extension in the installed pi (`/reload`), exercise spawn →
widget → done. If anything misbehaves, migrating imports to the
`@earendil-works` package names becomes the first real phase and re-orders the
rest.

Done when: spawn, messaging, settings page, and status widget all behave in
the installed pi, with a written verdict in this file's git history (commit
message or amended here).

### Phase 1 — `subagent_interrupt` tool — ✅ DONE 2026-09-23

Implemented and verified: `npm run typecheck` clean; `npm test` 255/255 pass (51 suites). Cancellation marks `RunningSubagent.userInterrupted` before teardown, sends tmux `Escape` / Herdr `esc` / background `SIGINT`, closes the surface, hides the widget entry, suppresses status transitions and pending questions, skips model fallback, and steers one concise interruption notice. Unknown/finished targets and Claude CLI children get clear errors; teardown failure reverts the marker.

Goal: give the parent a cancellation path. Today a runaway worker can only be
killed by hand in the pane.

Approach (mirrors the fork post-3.13.0, including its two bug-fix rounds):

1. Register `subagent_interrupt` accepting `id` or `name` (exact match,
   running Pi-backed agents only — error for `cli: claude` children).
2. Send Escape to the child pane (cancel the in-flight turn), then terminate
   the child pi process, close the pane, remove the entry from the running
   set, and let the existing watcher consume the exit.
3. Mark the run user-interrupted **before** the exit is observed so the
   completion reminder is suppressed (fork 3.10.1: "suppress reminders after
   aborted or failed runs"). Steer a one-line "interrupted" notice instead of
   the full result.
4. Widget: entry disappears (process is gone). Ignore stale pre-interrupt
   snapshots arriving after the interrupt marker.

Files: `pi-extension/subagents/index.ts` (tool registration + interrupt
handler + marker on `RunningSubagent`), `status.ts` only if snapshot gating
needs a flag.

Done when: (a) interrupting a mid-turn agent leaves no pane, no running-set
entry, and no completion reminder in the transcript; (b) interrupting an
already-finished or unknown id/name returns a clear error; (c) unit tests
cover marker suppression and double-interrupt; (d) README documents the tool.

### Phase 2 — Path-based resume — ✅ DONE 2026-09-24

Implemented and verified: `npm run typecheck` clean; `npm test` 261/261 pass (51 suites). `subagent_message` accepts an optional `sessionPath` (mutually exclusive with `name`); path-addressed resumes reuse the existing loadout-replay machinery, reclaim the registry name when known else derive a unique one from the filename, and refuse without a sidecar while naming the missing `.loadout.json` path. README documents the parameter.

Goal: resume a recorded session `.jsonl` by path — covers pi restarts and
sessions not in the current registry. Our name-based `subagent_message`
resume keeps working unchanged.

Approach: add an optional `sessionPath` parameter to `subagent_message`
(mutually exclusive with `name`). Reuse the existing resume machinery:

1. If a `.loadout.json` sidecar exists next to the session file, replay the
   sandbox from it (same guarantee as name-resume: exact model, tool
   allowlist, extensions, model, thinking, system prompt).
2. If the sidecar is missing, refuse with an error naming what's missing —
   consistent with our existing refusal of pre-sandbox sessions.
3. Reclaim the original display name recorded in the loadout/registry if
   available; otherwise derive one from the filename.
4. Fire-and-forget like every other spawn; result steers back later.

Files: `pi-extension/subagents/index.ts` (param + resolution), `session.ts`
(sidecar lookup helper if not already exported).

Done when: (a) messaging by `sessionPath` resumes a finished agent with its
loadout replayed and steers the result back; (b) a session without a sidecar
is refused with a clear error; (c) passing both `name` and `sessionPath` is a
parameter error; (d) README documents the parameter.

### Phase 3 — Durable user-dir config — ✅ DONE 2026-09-24

Implemented and verified: `npm run typecheck` clean; `npm test` passes. All configuration reads and writes now default to `<agentDir>/extensions/pi-interactive-subagents/config.json`, honoring `PI_CODING_AGENT_DIR`. The package-local `config.json` path is no longer used, migrated, or imported.

Goal: settings survive package reinstalls. Our persisted config lived in the
package directory and was clobbered on every update; the fork stores
user config in the pi agent dir for this reason.

Approach:

1. Moved persisted state (`status.enabled`, `multiplexing.backend`, per-agent
   model/thinking overrides) to
   `<agentDir>/extensions/pi-interactive-subagents/config.json`, honoring
   `PI_CODING_AGENT_DIR`.
2. Removed the package-local config path entirely: no migration, no
   package-file fallback, and no ongoing compatibility layer. An obsolete
   package-local `config.json`, if present, is ignored.
3. `/subagent-settings` stays the UI and writes to the new path atomically
   through the existing config-state machinery.
4. `config.json.example` remains in the package purely as schema
   documentation.
5. Unified the previously separate `surface.ts` multiplexing loader onto the
   same durable config-path helper.
6. Removed package-local `config.json` from `.gitignore`-relevant scope.

Files: `pi-extension/subagents/config.ts` (path resolution),
`surface.ts` (shared durable path), `settings.ts` (user-agent wording),
`README.md`, `.gitignore`.

Done when: (a) changing a setting persists to the user-dir path and survives
`pi install` of a fresh package copy; (b) a package-local `config.json` is
not read, written, migrated, or imported; (c) deleting the user-dir file
returns to example/default behavior; (d) unit tests cover the durable path
and `PI_CODING_AGENT_DIR` handling.

### Phase 4 — `/plan` workflow skill + planner/reviewer agents

Goal: batteries-included orchestration. The fork's `/plan` is a skill file
injected as a user message that scripts the main agent through phases —
cheap (no new machinery) and high value.

Approach:

1. Port `plan-skill.md` (fork: `pi-extension/subagents/plan-skill.md`) with
   its phase flow: quick assessment → scout → interactive planner → plan &
   todo review → sequential workers → reviewer, plus the artifact convention
   `.pi/plans/YYYY-MM-DD-<name>/` (`scout-context.md`, `plan.md`,
   `review.md`).
2. Port bundled agents `planner.md` and `reviewer.md` (fork `agents/`).
   Adapt model fields to our convention: planner interactive (no
   `auto-exit`), reviewer `auto-exit: true`, `thinking` levels kept. Replace
   their `model:` values (`claude-*`) with our bundled default pattern
   (`openrouter/z--ai/...` + `model-fallback: inherit`) to match
   `scout.md`/`worker.md`/`researcher.md`.
3. Register `/plan <what to build>`: strip frontmatter from the skill file,
   send `pi.sendUserMessage("<skill name=plan>…</skill>\n\n<task>")` — same
   mechanism the fork uses.
4. Add `interactive` to the `subagent` tool parameter schema
   (`SubagentParams`, `index.ts:110`). Today it exists only as agent
   frontmatter (`index.ts:350`); the tool call accepts
   `agent/task/name/model/thinking/cwd` only, and the `/plan` skill needs
   per-spawn `interactive: true` for the planner. Resolution order: explicit
   param > frontmatter (extend `resolveInteractive` at `index.ts:686`).

Files: `pi-extension/subagents/plan-skill.md` (new), `agents/planner.md`,
`agents/reviewer.md` (new), `pi-extension/subagents/index.ts` (command +
`interactive` param check), `README.md`.

Done when: (a) `/plan dark mode` produces a planning run: scout spawn,
planner pane the user can converse in, workers spawned sequentially from
todos, reviewer run at the end; (b) artifacts land under
`.pi/plans/YYYY-MM-DD-<name>/`; (c) `subagents_list` shows planner and
reviewer with project>global>package precedence; (d) `interactive` is
supported end-to-end (spawn param → child behavior).

### Phase 5 — Programmatic bridge + `hiddenFromWidget`

Goal: let other extensions launch subagents without widget clutter, the way
the fork's `pi-dynamic-workflows` does.

Approach: port directly —

1. Extend the existing bridge — we already set
   `globalThis.__pi_interactive_subagents = { registerToolExtension }` at
   module load (`index.ts:225`) — with `launchSubagent` and `watchSubagent`:
   `launchSubagent(params, options?)` returns the running handle and
   `watchSubagent(handle, signal)` resolves the `SubagentResult`. Keep the
   existing object identity; do not add a second global.
2. Add `hiddenFromWidget?: boolean` to the launch options; the widget and
   status capping read the filtered running set
   (`[...runningSubagents.values()].filter(a => !a.hiddenFromWidget)`).
   Hiding is display-only: watching, interrupt (Phase 1), and result steering
   are unaffected.
3. Also export `launchSubagent` / `watchSubagent` from `index.ts` for direct
   imports.

Files: `pi-extension/subagents/index.ts`.

Done when: (a) a test script via `globalThis.__pi_interactive_subagents`
spawns, hides from the widget, and steers its result back; (b) normal
`subagent` spawns still appear; (c) `registerToolExtension` on the same
object keeps working (project-local extension tool registry unaffected);
(d) the bridge survives `/reload` (re-registered on module load, like our
other `Symbol.for` globals).

### Phase 6 — Test depth pass

Goal: reach the fork's confidence level (~140 unit tests) for everything
touched above plus our untested areas.

Approach: port test patterns from the fork where applicable and write the
rest:

- status transitions: `starting` → `active` → `waiting`/`stalled`/recovered,
  watchdog timing, stale-snapshot gating (incl. Phase 1 markers);
- interrupt lifecycle (Phase 1);
- config import-once + user-dir persistence (Phase 3);
- loadout replay on path-resume (Phase 2);
- nudge/reminder suppression on abort (we have the behavior; the fork has
  explicit tests to mirror).

Done when: `npm test` passes with the new suites; every Phase 1–5 item's
criteria are covered by at least one test; coverage run
(`npm run test:coverage`) shows no 0-coverage files under
`pi-extension/subagents/`.

### Phase 7 — SKILL.md

Goal: agents can configure and verify the package on request, matching our
repo's skills conventions.

Approach: a short skill describing config surface (`/subagent-settings`,
config schema, user-dir path, env vars `PI_SUBAGENT_SHELL_READY_DELAY_MS`,
`PI_SUBAGENT_MUX`-equivalent backend selection), bundled agents, and
verification steps (spawn a test agent in tmux/herdr/background). Declare it
in `package.json` under `pi.skills` if the loader supports it, else document
at repo root.

Done when: `pi` loads the skill and an agent can follow it to change a
setting and verify with a test spawn, unaided.

## 4. Backlog / deferred

- **Structured-output contracts for children** (`PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA`
  + Ajv validation of the child's final result). Blocked on the Phase 2
  scope decision: adopting it requires switching completion to an explicit
  `subagent_done` call (the fork's rationale), which we deliberately did not
  take. Revisit only when a consumer needs JSON from children.
- **`pi-terminal-mux` adoption** (muxy/cmux/zellij/wezterm/otty/orca
  backends). Gate: Phase 0 verdict on the `@earendil-works` API; the library
  targets >=0.80. Our `background.ts` headless mode stays as our own backend
  regardless — the library has no headless equivalent.
- **Terminal-naming cooperation** (fork writes fresh
  `PI_TERMINAL_RENAME_CONTEXT` per child so a naming extension renames only
  the child's terminal). Relevant only if we adopt or interop with a naming
  extension.
- **Upstream API migration** (`@mariozechner/*` → `@earendil-works/*`).
  Mandatory if Phase 0 finds skew; otherwise fold into the next routine
  dependency bump.

## 5. Reference

- Fork source: clone `https://github.com/maplezzk/pi-extensions`, package at
  `packages/pi-interactive-subagents/`. Its `CHANGELOG.md` dates each change
  (3.9 orca backend, 3.10 herdr layouts, 3.10.1 reminder suppression, 3.11
  config skill, 3.11.1/3.13 interrupt fixes, 3.14 extension candidates +
  config command, 3.15 source tags, 3.16 transcript-block notices).
- Upstream: `amosblomqvist/pi-interactive-subagents` (GitHub user HazAT).
- Our key files: `pi-extension/subagents/{index,session,settings,config,
  status,activity,subagent-done,surface,tmux,herdr,background}.ts`,
  `agents/{scout,researcher,worker}.md`, `test/{test.ts,integration/}`.
