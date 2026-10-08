# pi-interactive-subagents

[![Herdr](https://img.shields.io/badge/Herdr-v0.9.0%20tested-2b6cb0)](https://herdr.dev/)
[![tmux](https://img.shields.io/badge/tmux-v3.7c%20tested-1bb954?logo=tmux&logoColor=white)](https://github.com/tmux/tmux)

Async subagents for [pi](https://github.com/badlogic/pi-mono), running in tmux or [Herdr](https://herdr.dev/) panes, with a headless background mode. Spawn a sub-agent, keep working in the main session, and get the result steered back when it finishes. Fully non-blocking.

## How it works

`subagent()` returns immediately. The sub-agent runs on the selected surface backend without stealing keyboard focus. tmux chooses a right/down split from window dimensions. Herdr uses a right split with the parent process's explicit `HERDR_PANE_ID` and `--no-focus` (never implicit focus or `--current`). A live widget above the input tracks every running sub-agent, and when one finishes, its result is steered into the main session as a notification that triggers a new turn.

```
╭─ Subagents ───────────────────────────────────────────────────────────── 2 running ─╮
│ ⟳ 00:23  scout                                                     active · bash 7s │
│          ↳ ↑14k↓420  $0.008                            gemini-3.7-flash · 7.1%/1M │
│ ○ 00:45  cleanup-design [worker]                                  waiting 2m · done │
│          ↳ ↑39k↓1.6k  R12k  $0.042                        gpt-5.6-sol · 19.6%/200k │
╰─────────────────────────────────────────────────────────────────────────────────────╯
```

Agent profiles appear as dim `[worker]` badges only when the display name differs from the profile name (ignoring case). Transcript headers share the `subagent · name [profile]` identity; completions show the result first, followed by a dim divider and a single muted footer line: `model:thinking · N tools · duration · ↑input ↓output`, for both new spawns and resumed Pi agents. Cache, cost, context usage, and follow-up/session details appear only when expanded; narrow terminals wrap the footer. Completion tool counts and usage are cumulative across the recorded session. Run independent profiles in parallel within their configured concurrency limits; their results steer back independently. The bundled worker declares `max-concurrent: 1`, rather than receiving special treatment in code. Limits are per profile and parent runtime, including startup, resume, and model fallback.

Panes are kept evenly sized after every spawn and exit (debounced). The extension reads the tmux window dimensions and applies `even-horizontal` (equal columns) when columns are at least twice the row count (accounting for character cell aspect ratio), or `even-vertical` (equal rows) for portrait/square dimensions. Resizing alone does not trigger a rebalance; the new aspect ratio takes effect on the next spawn or exit.

If your shell startup is slow and launch commands get dropped before the prompt is ready, raise the delay:

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500   # default: 500
```

## Tools

| Tool | Description |
| --- | --- |
| `subagent` | Spawn a sub-agent in a dedicated tmux pane (async) |
| `subagent_interrupt` | Cancel a running Pi-backed sub-agent by exact `id` or `name` — terminates its process and closes its pane |
| `subagent_message` | Message a sub-agent by name (or `sessionPath`) — steers it if running, resumes its session if finished |
| `subagents_list` | List available agents with effective defaults for new spawns |
| `ask_question` | *(sub-agent sessions only)* Ask the orchestrator a question and wait for the reply |

There is also a `/subagent <agent>[@<model>][:<thinking>] [task]` command for requesting a spawn through the main model, and a `/subagent-settings` page for backend, status widget, per-agent model/thinking defaults, and orphan cleanup. For example, `/subagent worker:high Fix the tests` overrides only the thinking level, while `/subagent worker@openai/o3-mini:high Fix the tests` overrides both model and thinking. Colons in model IDs are preserved, so `/subagent worker@ollama/llama3.1:8b Fix the tests` selects the `ollama/llama3.1:8b` model.

### Shell safety

Pi subagents granted `bash` require a configured, installed **`@zle13/pi-bash-guard` >= 0.3.0**:

```bash
pi install npm:@zle13/pi-bash-guard@^0.3.0
```

The extension explicitly loads the guard despite `--no-extensions` and sets `PI_BASH_GUARD_APPROVAL_MODE=deny`. Commands passing the guard's existing rules/Jev assessment run normally; commands requiring approval are denied, including assessment failures/timeouts. No approval dialogs open in child panes. This launch policy keeps the guard enabled despite config, flags, or session toggles. The footer shows `⛨ BG deny`, retaining existing watchdog activity and decision counts.

Missing, incompatible, or failed guard initialization stops the child; there is no unguarded or `safe_bash` fallback. Guard sources are resolved from Pi's configured installed packages (project before user), never downloaded during launch, and pinned in the loadout for resume. Guarded children start with Pi's `--offline` flag to prevent startup package installs/updates from changing that pinned source. This also skips startup catalog/helper downloads; missing or version-mismatched package resources are unavailable until installed separately. Normal model inference and web tools remain network-capable. Resumes validate and replay that source rather than substituting a currently configured package. Bash snapshots without a pinned guard must be replaced by a new launch.

Alternatively, explicitly select `safe_bash` for its existing static dangerous-command filtering. Choose **one** shell policy per profile; granting both is rejected. Neither policy enforces read-only execution, so read-only profiles should remain shell-free. Codemode's `tools.bash()` runs through the same guard hooks. Other shell-executing tools and Claude CLI agents are outside this integration.

### Codemode (Pi 1.0)

Codemode is included in the bundled **scout**, **researcher**, and **worker** profiles for batching independent calls and filtering large results. Custom profiles remain **opt-in**: include `codemode` in an agent's `tools` frontmatter alongside every tool its scripts may call:

```yaml
tools: read, grep, find, ls, codemode
```

Restricted launches explicitly load `-e builtin:codemode` despite `--no-extensions`; resume uses the same sandbox helper and recorded tool allowlist. Codemode does not grant extra tools or spawning permission. Pi's `codemode.mode` and `codemode.inlineBudget` presentation settings are left unchanged. For the parent session, enable codemode through Pi's own tool selection/settings.

These tools declare output schemas, so `tools.<name>(args)` in codemode resolves to structured data instead of parsing acknowledgement text:

- `subagents_list`: `{ agents: [{ name, source, description?, model?, thinking?, modelFallback? }] }`. `source` is `package`, `global`, or `project`; an empty list is `{ agents: [] }`. This lists effective defaults for **new spawns**, including current settings overrides, **not running status** or resumed loadouts. Model thinking suffixes are separated into `thinking`; unset model/thinking fields are omitted (Pi chooses its defaults). Disabled fallback is omitted; `inherit` remains literal. Profile bodies/private loadout data are excluded.
- `subagent`, `subagent_message`, `subagent_interrupt`: `{ ok, status, id?, name?, agent?, sessionFile?, sessionId?, messageId?, error? }`. Optional handles come from existing result details. Status is `started` (spawn or resume), `queued` (running Pi child), `interrupt_requested`, or `interrupt_already_requested`. Returned validation/operation errors have `ok: false`, `status: "error"`, and `error`; thrown failures still reject.

`ok: true` means only that the operation was acknowledged — **not that the child's task completed**. `queued` confirms durable inbox acceptance, not child receipt; ingestion is acknowledged in the session's control artifacts after persistence or question-answer consumption. Spawn/resume completions arrive later as steer messages; a queued-message acknowledgement itself does not emit another result. Interruption acknowledgements precede the watcher's removal notice. Do not poll or infer completion from an acknowledgement.

```js
const { agents } = await tools.subagents_list({});
text(agents.map(({ name }) => name));
// Only in a session granted spawning tools:
const ack = await tools.subagent({ agent: "scout", task: "Analyze the auth module" });
text(ack); // acknowledgement only; the harness delivers the eventual result
```

### Spawning

```typescript
subagent({ agent: "scout", task: "Analyze the auth module" });
subagent({ agent: "worker", name: "dark-mode", task: "Implement the dark mode toggle" });
```

| Parameter | Type | Default | Description |
| --------- | ---- | ------- | ----------- |
| `agent` | string | required | Which agent to spawn (must be known and permitted) |
| `task` | string | required | Task prompt |
| `name` | string | agent name | Display name for the pane and widget. Must be unique — duplicates are auto-suffixed (`scout`, `scout-2`, …) |
| `model` | string | page override, else agent's model | Persistent default for this spawn, set in `/subagent-settings`. May include a `:thinking` suffix (for example, `provider/model:high`) |
| `thinking` | string | page override, else agent's thinking level | Persistent default for this spawn, set in `/subagent-settings` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or a token budget). `none` is normalized to `off`; an explicit value overrides a suffix in `model` |
| `cwd` | string | agent's `cwd` | Working directory (see [Role folders](#role-folders)) |

### Messaging

`subagent_message` is addressed **by name or by session path**. Names are unique per session and persist after a sub-agent finishes, so the same name works either way:

```typescript
subagent_message({ name: "scout", message: "Also check the auth middleware" });
```

- **Running Pi child** — the full message is written to a durable inbox and the call returns `queued` with a message ID. The child consumes it at a turn boundary or as its pending question's answer. Delivery and closure share a mutex; messages submitted after closure are explicitly refused, not falsely reported delivered. Wait for completion before retrying as a resume.
- **Finished Pi child** — the session is resumed autonomously with the follow-up task; its result arrives later. Concurrent requests for the same session in one runtime join its startup instead of launching multiple writers. The resumed run reclaims its name and recovers retained unacknowledged messages.
- **Claude CLI child** — messaging and message-based resume are refused because this backend cannot provide ingestion acknowledgements or durable inbox consumption. Claude spawning and result reporting remain supported; spawn a fresh child for further work.

Pass `sessionPath` instead of `name` to resume a recorded session (`.jsonl`) file directly, bypassing the name registry:

```typescript
subagent_message({ sessionPath: "/path/to/artifacts/<id>/subagents/subagent-ab12cd34.jsonl", message: "Now fix the migration too" });
```

Provide exactly one of `name` or `sessionPath`. Path resume reaches sessions missing from the current session's registry — e.g. after starting a fresh pi session, or children of a nested sub-agent (registered under their spawner's session id, not yours). The registry name is reclaimed when the file is known to the current session; otherwise a display name is derived from the filename. The `.loadout.json` sandbox snapshot must sit beside the session file or resume is refused, exactly as with name resume — a path never relaxes the sandbox.

Every spawn persists name → session file in `artifacts/<sessionId>/subagent-registry.json` before submitting the child command. Explicit names already used in this parent session are rejected, including finished handles; omitted names are uniquified. A newly named path resume also saves its handle. A nested spawner has its own registry keyed by its session ID.

### Session ownership and delivery safety

Each managed session has a canonical-path `<session>.control` directory containing its owner, immutable inbox records, receipts, and completion evidence. Symlink aliases share ownership; multiply hard-linked sessions are refused. Separate spawners cannot launch writers against the same session. A delivery-closed marker is not proof of process exit: replacement ownership requires the matching outer wrapper's post-exit completion record. Watchers read immutable completion archives keyed by owner/run, including rich error outcomes, so a successor cannot hide the original result by consuming the live completion file.

Unacknowledged messages remain in the inbox and are identified in completion/interruption reports; an explicit resume recovers them. Abandoned mutexes, unknown owners, and ambiguous termination fail closed with diagnostics. Ownership is never guessed from age or PID, and OS-crash exactly-once delivery is not promised. Orphan cleanup removes only validated, terminated control groups under their mutex. Busy, active, ambiguous, or foreign/symlink-containing groups retain their related files and discovery markers.

**Reload the parent extension before new launches after updating.** Recorded sessions without the new ownership metadata cannot be resumed, even if they have a loadout snapshot; spawn a fresh child rather than bypassing the guard. Resume also refuses missing names, missing session files, or missing loadout snapshots. Concurrency limits are process-local and profile-scoped, not workspace-wide locks across independent orchestrators.

### Interrupting

`subagent_interrupt` cancels a running **Pi-backed** sub-agent addressed by exact `id` or `name`:

```typescript
subagent_interrupt({ name: "scout" });
```

This is cancellation, not a pause: it sends Escape (SIGINT for headless background runs) to stop the in-flight turn, terminates the child process, closes the pane, and removes the widget entry. The watcher then steers one concise interruption notice instead of the full completion result, and the run is excluded from model-fallback retry. The notice attributes cancellation to the runtime caller: the main agent in a top-level session, or the parent sub-agent (using its runtime name, profile, or ID) in a nested session—not to the human user. Attribution is captured from the caller's environment at tool entry, never from tool arguments. Final notification details include `interrupted: true` and `interruption: { actor, requestedAt }`; `actor` is `{ kind: "main_agent" }` or `{ kind: "parent_subagent", id, name?, agent? }`, and `requestedAt` is the request time in epoch milliseconds. Interrupting an unknown or already-finished `id`/`name` returns a clear error, as does a child running through the Claude Code CLI.

**Resume replays the original sandbox.** At spawn time the fully-resolved loadout — tool allowlist, backing extensions, model, thinking level, system prompt, spawn whitelist, cwd — is snapshotted to `<session>.loadout.json`. Resume rebuilds the exact same restricted process from that snapshot rather than relaunching unrestricted.

### ask_question

A sub-agent can ask its orchestrator a single freeform question when requirements are ambiguous or a decision materially affects the work. The `ask_question` tool call **waits for a reply**: the model cannot continue to its next provider request while it is pending. The parent is notified with the sub-agent's name and replies via `subagent_message({ name, message })`. The first valid reply for the current run is returned once as the tool's answer, not also injected as a custom message or a new turn. A human can answer through the child's input too.

Different sub-agents can wait in parallel; each child permits only one pending question. Further messages follow the ordinary steer path. Abort or session shutdown releases the wait and removes the pending question file; abort parks the session rather than completing the task. If nobody replies or cancels, the tool keeps waiting. Only available inside sub-agent sessions.

## Bundled agents

| Agent | Model | Tools | Role |
| ----- | ----- | ----- | ---- |
| **scout** | `openrouter/z-ai/glm-5.3` | `read`, `grep`, `find`, `ls`, `codemode` | Fast read-only codebase recon |
| **researcher** | `openrouter/z-ai/glm-5.3` | `web_search`, `fetch_content`, `get_search_content`, `source_check`, `bash`, `codemode` | Web research, synthesized into a sourced brief |
| **worker** | `openrouter/z-ai/glm-5.3` | `read`, `write`, `edit`, `bash`, `web_search`, `fetch_content`, `get_search_content`, `codemode` + spawning | General implementer; may spawn `scout` and `researcher` |

All three are autonomous (`auto-exit: true`), carry their identity in the system prompt (`system-prompt: append`), and use the immediate spawner's model as a one-shot fallback if GLM-5.3 fails.

### Keeping orchestration lean

- Use one worker for implementation and parallel read-only agents for independent investigations. Assign file ownership and one integration/test owner; separate conversations do not isolate a shared workspace. Use separate worktrees when overlapping edits are unavoidable.
- Resume for focused follow-ups on the same task. For a substantially new phase, spawn a fresh agent with a short handoff and a new name.
- Request concise findings, decisions, blockers, changed paths, and verification counts. Main should inspect critical changes and run final integration checks instead of repeating broad exploration or ingesting full passing logs.
- Result transport remains lossless: the normal Pi child's full final text is embedded in a completion wrapper. Collapsing its TUI preview does not reduce parent context. Keep reports concise through task/profile instructions; store lengthy evidence in files when appropriate.

## Custom agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global). Discovery priority: **project > global > package-bundled** — a project-local file overrides a bundled agent with the same name.

```markdown
---
name: my-agent
description: Does something specific
model: openrouter/z-ai/glm-5.3
model-fallback: inherit
thinking: medium
tools: read, edit, write, safe_bash, web_search
session-mode: lineage-only
auto-exit: true
---

You are a specialized agent that does X...
```

### Frontmatter reference

| Field | Type | Description |
| ----- | ---- | ----------- |
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` |
| `model` | string | Primary/default model |
| `model-fallback` | string | Optional one-shot fallback model. Use `inherit` to copy the immediate spawning session's live model, or provide a concrete model id |
| `thinking` | string | Default reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or a token budget) |
| `max-concurrent` | positive integer | Maximum admitted runs of this profile per parent runtime; omission means Unlimited. Applies to starts and resumes, including startup and fallback; settings can override it |
| `tools` | string | Strict tool allowlist. Built-ins: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`. Opt-in built-in extension: `codemode`. Extension-backed: `web_enable`, `web_search`, `fetch_content`, `get_search_content`, `source_check`, `safe_bash`, `video_extract`, `youtube_search`, `google_image_search`. Only the extensions backing the listed tools, plus required bash-guard when `bash` is granted, are loaded into the child |
| `subagent_agents` | string | Comma-separated agent names this agent may spawn. A nonempty effective list grants the spawning toolset (`subagent`, `subagent_interrupt`, `subagent_message`, `subagents_list`) and restricts targets to that list within the parent's allowed agents. Settings can override the list; an empty list disables spawning |
| `skills` | string | Comma-separated skill names to auto-load |
| `session-mode` | string | `standalone` (default), `lineage-only`, or `fork` — see below |
| `system-prompt` | string | `append` or `replace`: pass the body as the child's `--append-system-prompt` / `--system-prompt`. Omit and the body is prepended to the task prompt instead |
| `auto-exit` | boolean | Auto-shutdown when the agent finishes (see below) |
| `interactive` | boolean | Whether stall/recovery transitions wake the parent (see below) |
| `cwd` | string | Default working directory |
| `disable-model-invocation` | boolean | Hide from `subagents_list`; still spawnable by explicit name. Overridable with **Visible to model** in settings |
| `cli` | string | `claude` runs the agent via the Claude Code CLI instead of pi |

### Web tool activation

Web-capable bundled profiles grant `web_enable` alongside `web_search`, `source_check`, `fetch_content`, and `get_search_content`. The loader and capabilities share one pi-web-access extension snapshot. Keep the underlying capabilities in the allowlist: the loader cannot grant excluded tools, and pi-web-access currently rejects activation if a globally configured capability is unavailable in the child. It is omitted from Scout.

pi-web-access's `toolActivation: "auto"` chooses lazy or eager activation according to model compatibility; `"eager"` does not use the loader. New profile grants apply to fresh children; existing/resumed sessions retain their recorded sandbox.

### Concurrency policy

Set `max-concurrent: 1` in any profile to serialize it, or a larger positive safe integer to allow bounded parallelism. Omit the field for Unlimited. Empty, zero, negative, fractional, and unsafe values are invalid; an invalid higher-priority profile still shadows lower-priority definitions and its admissions fail explicitly.

The settings override `agents.<name>.maxConcurrent` takes precedence: a positive safe integer is a limit, `null` is explicit Unlimited, and absence uses the profile default. The **current** policy is checked before each new spawn or resume; reducing it never cancels existing runs. Unlimited runs are counted too, so a later stricter limit sees them. Same-session messages/startup joins do not consume another slot, and a fallback retains its original admission.

This is parent admission policy, not a frozen child permission. Resumes keep their original tools/model sandbox while using the current concurrency policy. Limits also govern Claude CLI spawning; Claude message-based resume remains unsupported.

### Model fallback

`model-fallback` is attempted once when the primary run reports a provider/agent error, exits non-zero, or exits without any non-whitespace assistant text. The failed child is retained in the parent's artifacts and a fresh child starts from the original task under the same display name. User cancellation never triggers fallback, and a fallback that resolves to the same model and thinking level is skipped.

With `model-fallback: inherit`, nested agents inherit from their **immediate spawner**, not always from the top-level conversation. Fallback thinking resolves in this order: an explicit per-spawn value, the settings-page override, the agent's `thinking`, the spawner's live thinking level, then Pi's default. The fallback model and thinking are frozen in the retry's loadout, so later `subagent_message` resumes replay the same selection.

## Configuration (agent-dir `config.json` + `/subagent-settings`)

The persisted store is `<agentDir>/extensions/pi-interactive-subagents/config.json` (`status`, `multiplexing.backend`, per-agent `agents` overrides), honoring `PI_CODING_AGENT_DIR`. This keeps settings outside the installed package, so reinstalling or replacing the package does not erase them. Package-local `config.json` is obsolete and is no longer read; `config.json.example` remains the committed template. Every successful selection or list toggle is saved immediately with an atomic write; no separate Apply step is required. Loadout overrides apply to **new spawns only**; running agents and resumed sessions keep their original loadouts. **Max concurrent** is the exception: current policy governs subsequent spawn/resume admissions, without stopping existing runs. General settings still apply live.

```json
{
  "status": { "enabled": true },
  "multiplexing": { "backend": "auto" },
  "agents": {
    "worker": {
      "model": "openai/gpt-5",
      "thinking": "high",
      "maxConcurrent": 2,
      "tools": ["read", "bash", "edit", "write"],
      "subagentAgents": ["scout", "researcher"],
      "skills": [],
      "modelFallback": "inherit"
    }
  }
}
```

### Settings page (`/subagent-settings`)

`/subagent-settings` opens a settings page (same style as pi's `/settings`) with two tabs:

- **Agents** (default) — search `scout`, `researcher`, `worker`, and custom agents. Rows show the effective model and thinking level in aligned columns; long model names shorten before the thinking level does, and search keeps the same column positions. A `*` after an agent name indicates saved overrides (including explicit empty lists or disabled fallback); the `* Saved overrides` legend explains it. Resetting the final overridden field removes the marker. The suffix is display-only and does not change names or search. Open an agent for compact, aligned settings rows: model/thinking/fallback above the second group (Tools, Skills, Spawnable agents, Max concurrent), with reset at the bottom. A shared help area shows the focused field's source (**Agent default**, **Custom override**, **Pi default**, or **Extension default** for an omitted concurrency limit) and explanation; list memberships are summarized rather than filling the page. Long scalar values expand in the help area where space permits. **Model** searches registered `provider/model` IDs with regex; **Thinking** selects reasoning effort (shown as `off` and locked for non-reasoning models). **Tools**, **Spawnable agents**, and **Skills** open searchable multi-select pickers. Skills are startup `/skill:name` prompts, not a skill-access restriction. **Model fallback** selects one registered model, `inherit`, or **Disabled**, using the existing single-retry behavior. **Max concurrent** accepts a positive safe integer or explicit **Unlimited**; invalid/cancelled input leaves the previous value intact. **Delete** resets the focused field to its agent default; **Reset to agent defaults** at the bottom removes all overrides. Single-value choices return to the agent page; list toggles save immediately and keep the picker open. Tools/spawnable agents/skills/fallback controls support Pi-backed agents only and are marked unsupported for `cli: claude`; Max concurrent is backend-neutral.
- **General** — **Launch surface** selects Automatic, tmux, Herdr, or Background. Setting names and values use aligned columns with a clear spacing gap. Automatic shows the resolved surface in parentheses (for example, `Automatic (Herdr)`); the picker marks unavailable surfaces. **Status widget** toggles **On / Off** directly. **Orphan cleanup** shows `N orphans · X files · Y KB`; open it to review candidate directories and confirm deletion of only the selected directory's recognized extension artifacts. Other files are preserved.

Use **← / →** for the previous / next panel when the search is empty, **Tab / Shift+Tab** to cycle forward / backward, or click a tab. When a search query exists, horizontal arrows move its cursor—even at the query's beginning or end—while Tab / Shift+Tab still switch panels. Each panel retains its selection, and Agents retains its search. Panel switching is disabled in nested screens, which replace tabs with breadcrumbs; **Esc** returns one level, then closes the page from a panel's list. Search errors and empty results explain how to recover. In list pickers, **Space / Enter** or a checkbox click toggles and saves immediately; **Esc** returns without undoing saved changes. The concise footer shows move, toggle, and back shortcuts. Keyboard hints wrap at narrow widths.

**Visible to model** is a per-agent On/Off toggle supported by both Pi and Claude CLI profiles. Enter or Space toggles it and saves immediately. Off hides the agent from `subagents_list`, but does not prevent explicit spawning by name or remove it from settings or spawnable-agent choices. The saved `agents.<name>.disableModelInvocation` boolean overrides the Markdown `disable-model-invocation` field (`false` means visible); without either, agents are visible. Delete restores the profile default, and **Reset to agent defaults** also clears the visibility override. Visibility changes take effect on the next listing without a reload and do not stop running agents.

Absent override fields use the agent Markdown defaults. Explicit `tools: []` grants no optional tools, `skills: []` invokes no startup skills, `subagentAgents: []` disables spawning, `modelFallback: null` disables fallback, and `maxConcurrent: null` explicitly removes a profile's concurrency limit. If neither the definition nor settings specify tools, new agents inherit the spawner's active optional tools. `ask_question` remains a managed control tool; spawning tools are managed automatically from the effective spawnable-agent list, which cannot widen an inherited agent restriction. The Tools picker includes supported Pi built-ins even when excluded or inactive in the parent, built-in extensions `codemode` and `tool_search`, bundled `safe_bash`, and registered workspace extension tools, deduplicated by name. Other pickers use current-session discoveries. Unavailable existing entries are preserved rather than silently deleted. Adding tools to the catalog does not change the inherited active-tool defaults. Child tools remain independently configurable; parent CLI tool exclusions are not a delegation ceiling. Shell tools are mutually exclusive: `bash` requires bash-guard in enforced deny mode, while `safe_bash` retains its static filtering. See [Shell safety](#shell-safety).

Model/thinking precedence is **explicit spawn args > settings-page override > agent markdown default**. The old `/subagent-mux` and `/subagent-sessions` commands are removed; explicit `/subagent agent@model:thinking` args still win for a single spawn.

### session-mode

- `standalone` — fresh session, no lineage link to the caller (default)
- `lineage-only` — fresh session with `parentSession` linkage for discovery/fork UX, but no copied turns
- `fork` — child session seeded with the caller's conversation context

In `fork` mode, the child inherits the caller's conversation branch with unresolved tool calls and `/subagent` dispatch directives removed at seed time. Dispatch directives address the parent, not the child—even when the child has spawning tools. `[pi-subagent-dispatch]` is a reserved prefix: a user message is stripped if its string content or first text block starts with that tag, regardless of authorship. Untagged natural user requests ("spin up an advisor to review this plan") are preserved, and the parent transcript is unchanged. The task is delivered with a `Task dispatched to you by the orchestrator:` header to distinguish the assignment from inherited context.

The `/subagent` command sends an explicit tool-call request to the main model; it does not bypass the model. This improves dispatch clarity but does not guarantee immediate execution or verbatim tool arguments. Supply a meaningful task rather than relying on the model to elaborate it.

### auto-exit

With `auto-exit: true`, the session shuts down at Pi 1.0's final `agent_settled` boundary — after retries, recovery, and queued work have settled, not at the earlier `agent_end` telemetry event. The agent just writes its final message and stops (there is no "done" tool). The last assistant message becomes the summary returned to the parent. Recommended for all autonomous agents.

Notes:

- **Manual input does not strand an auto-exit sub-agent.** If a human types into the pane, the session still closes once that turn completes normally. Normally aborted turns park instead of closing. **Pi 1.0 late-abort limitation:** an abort after the agent loop has completed, during final settlement callbacks, is not exposed by Pi's public API and may still auto-close the session; no private-API workaround is used.
- **Auto-exit is suppressed while work is in flight:** the session parks as `waiting` when an `ask_question` is unanswered, its own children are running, or accepted inbox messages lack receipts. `agent_before_settle` drains the inbox and serializes closure against enqueue; delayed receipts and transient mutex contention retry closure while idle without an extra provider request. Valid same-writer SDK continuations reopen delivery.

### interactive

Controls whether `stalled`/`recovered` status transitions send a steer message to the parent session. Defaults to the inverse of `auto-exit`: autonomous agents get stall pings; user-driven agents stay quiet (the user is already working in that pane — the widget still updates). Set explicitly to override.

## Tool access control

Pi sub-agent access is **whitelist-only**. Each new process uses `--no-extensions` and an explicit `--tools <allowlist>`; only backing extensions for allowed tools are reloaded. Settings override the frontmatter tool list. If neither specifies tools, the spawner's active optional tools are inherited. Managed control/spawning tools are added separately. Registered file-backed and built-in extension tools can be selected; tools without a reloadable source are marked unavailable. The resolved restriction survives resume via the loadout snapshot.

Spawns must name a known agent at **every** depth. A top-level session may spawn anything discoverable; a sub-agent may only spawn agents in its effective `subagent_agents` list, intersected with the spawner's inherited restriction (enforced via `PI_SUBAGENT_ALLOWED`). A nonempty effective list grants the spawning toolset (`subagent`, `subagent_interrupt`, `subagent_message`, `subagents_list`). There is no agentless spawn route.

Extensions can register additional tools for sub-agents at runtime via `registerToolExtension(name, path)` on the `__pi_interactive_subagents` process global.

## On-demand orchestration audit

```text
/subagents-audit
/subagents-audit <session-id-or-jsonl-path>
/subagents-audit <session-id-1>, <session-id-2> "/path with spaces/session.jsonl"
/subagents-audit compare <baseline-session> <other-session>
/subagents-audit profiles [directory]
```

The thin command injects the canonical `audit/INSTRUCTIONS.md`, absolute analyzer/reference paths, and JSON scope only while Pi is idle. With no arguments it targets the current recorded session, capturing its byte cutoff, active leaf, and actual session directory **before** injection; an ephemeral session instead asks for references. The captured directory honors effective CLI storage selection rather than overriding it with a conflicting environment variable. Nothing is installed as an always-advertised skill or tool. Loading the package extension also enables this command; no extra tool permissions are granted.

The agent invokes the bundled, dependency-free Node offline analyzer; the command itself does not run analysis. You can also run it directly:

```sh
node audit/analyze.mjs <session-id> --sessions-dir /configured/session/storage
node audit/analyze.mjs compare '/path with spaces/baseline.jsonl' /path/other.jsonl
node audit/analyze.mjs /path/session.jsonl --leaf <entry-id> --cutoff-bytes <byte-count>
node audit/analyze.mjs --help
```

IDs resolve from saved headers, not filenames or pane names. Bounded JSON reports include registry-corroborated nested children, canonical overlap memberships, physical usage (including abandoned branches and non-message requests), text sizes, outer tool counts, and entry/line evidence refs—never raw prompts or tool payloads. Fork-seeded records require scoped parent provenance before new-usage attribution; missing telemetry remains unknown. Leaf ancestry is separate from physical accounting and is not reconstructed model context or peak context. The captured current-session cutoff excludes this invocation. Historical audit-marker prefixes label bounded request/event metadata without hiding subsequent work; earlier audit activity remains in physical accounting as a potential comparison confounder. Whole-turn exclusion and historical audit provider-cost attribution are unknown.

Processing and output have hard limits; incomplete, missing, ambiguous, malformed, cyclic, or out-of-scope evidence is disclosed. Explicit file scope includes its local artifact tree; a configured `--sessions-dir` permits broader saved-storage resolution. Registry paths and symlinks escaping that scope are refused. A valid extension-owned artifact marker plus child placement/header can also corroborate children when registries are absent; transcript-only linkage requires bounded manual corroboration. A `parentSession` link alone may be a fork, not delegation. Profiles mode remains a semantic read-only review of effective prompts and configuration.

This is local analysis and recommendations, **not automatic fixes** or a live provider/collector. It never resumes audited sessions or modifies durable state. Larger reports need an authorized output path; keep raw transcripts private. The on-demand wrapper design follows prompt-snippets; extraction is specific to orchestration, not prompt mining.

## Role folders

`cwd` starts a sub-agent in a directory with its own config, so role-specific setups (CLAUDE.md, skills, extensions) apply:

```
project/
└── agents/
    ├── game-designer/   ← CLAUDE.md, .pi/…
    └── sre/             ← CLAUDE.md, .pi/…
```

```typescript
subagent({ agent: "worker", cwd: "agents/sre", task: "Review the deployment pipeline" });
```

Set a per-agent default with `cwd:` in frontmatter.

## Surface backends & background mode

Backend preference lives in the user agent config (`multiplexing.backend`) — see [Configuration](#configuration-agent-dir-configjson--subagent-settings) — or the `/subagent-settings` backend row.

`auto` selects Herdr when the process has `HERDR_ENV=1` plus `HERDR_PANE_ID`, tmux when it has `TMUX`, and otherwise background mode. If both nested environments are present, `auto` refuses to guess; explicitly select the intended backend. The effective choice is exported to children as `PI_SUBAGENT_BACKEND`, so nested subagents do not re-detect a different multiplexer.

`PI_SUBAGENT_BACKEND=auto|tmux|herdr|background` overrides config. Legacy `{ "multiplexing": { "enabled": false } }`, `PI_SUBAGENT_MULTIPLEX=0|1`, and `PI_SUBAGENT_DISABLE_TMUX=1` remain supported; the disable variable always forces background mode.

Herdr support is CLI-first and requires `herdr` on `PATH` while Pi runs in a Herdr pane. It uses only default split layout: `herdr pane split "$HERDR_PANE_ID" --direction right --no-focus`. No plugin, socket client, tabs, or advanced layout configuration is required. Herdr management CLI calls are bounded, but subagent task duration is not timed out. Tested against Herdr 0.9.0 (and tmux 3.7c).

Background output is saved to `artifacts/<sessionId>/subagent-logs/<name>-<id>.log`.

## Status widget

The widget tracks each sub-agent with a two-line status block: the primary line shows identity, elapsed time, and real-time state (`starting`, `active`, `waiting`, `stalled`, or `running`), while the secondary telemetry line shows cumulative token consumption (`↑in↓out`), cache metrics, cost, model, and color-coded context window occupancy. Sub-agent sessions also show their own tools widget — toggle it with `Ctrl+Alt+O`. Completion messages expand with `Ctrl+O`. Toggle the widget via the `/subagent-settings` status-widget row (persists to the user agent config).

## Session Storage & Orphan Cleanup

### Parent-Scoped Storage

Sub-agent session transcripts (`.jsonl`) and their sandbox loadout sidecars (`.loadout.json`) are stored within the parent session's artifact directory:

```
~/.pi/agent/sessions/--<project>--/
├── 2026-08-28T10-00-00-000Z_parentSessionId.jsonl       ← Interactive parent sessions only
└── artifacts/
    └── <parentSessionId>/
        ├── subagents/
        │   ├── 2026-08-28T10-09-42-000Z_uuid1.jsonl     ← Child subagent sessions
        │   └── 2026-08-28T10-09-42-000Z_uuid1.jsonl.loadout.json
        ├── subagent-registry.json
        ├── subagent-activity/
        └── subagent-scripts/
```

- **Clean Session Picker**: `pi -r` and `/resume` only list human/interactive conversations — sub-agent runs never clutter the picker.
- **Full Resumability**: Resuming via `subagent_message({ name, message })` resolves the scoped session path seamlessly from the parent's `subagent-registry.json`.
- **Nested Hierarchies**: When a worker subagent spawns child scouts or researchers, the children are nested in `artifacts/<parentSessionId>/subagents/artifacts/<workerSessionId>/subagents/`.
- **Explicit Retention**: Completed child sessions remain alongside the parent and are retained even after parent deletion until orphan cleanup is explicitly applied.
- **Existing History Unchanged**: Legacy top-level child sessions are not moved automatically; clean them up manually if desired.

### Orphan cleanup

Subagent artifacts are retained when their parent session is deleted. Cleanup is never run automatically: use the **Orphan cleanup** row in `/subagent-settings` when you want to inspect and remove them. The row shows an `N orphans · X files · Y KB` summary, refreshed when entering General or returning from cleanup. Enter previews candidate directories, then a confirmation deletes recognized extension artifacts only in the selected directory.

- **Marker-Only Ownership**: Cleanup considers only directories with a valid extension ownership marker matching the parent session ID. Familiar filenames alone are not treated as proof of ownership.
- **Preview First**: Cleanup defaults to a read-only, directory-level summary. It reports candidate directories, total stored file counts, and approximate sizes; it does not enumerate every file that will be removed.
- **Explicit Confirm**: deletion requires interactive confirmation. Before confirming, ensure no child process from a deleted parent is still running in another Pi process; cross-process liveness is not inferred from session files.
- **Foreign Data Preservation**: Only recognized extension files are removed; unrelated files in the same artifact directory are preserved.

## Requirements

- [Pi 1.0](https://github.com/earendil-works/pi)
- At least one execution surface:
  - [tmux](https://github.com/tmux/tmux) (tested with `tmux 3.7c`)
  - [Herdr](https://herdr.dev/docs/cli-reference/) (tested with `herdr 0.9.0`)
  - Built-in background mode

```bash
tmux new -A -s pi 'pi'   # tmux example
```

Do not install a Herdr integration/plugin for this extension; the standard Herdr CLI is sufficient.

## Acknowledgements

Forked from [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents), which originated the subagent architecture, the multi-multiplexer surface layer, and the status widget; its supervision features were inspired by [RepoPrompt](https://repoprompt.com/).

## License

MIT
