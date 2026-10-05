# Recorded-session audit

## 1. Resolve inputs and provenance

Resolve paths directly. For IDs, search the configured Pi session directory and its artifact subtrees, using the session header's `id` as authority rather than filenames or pane names. Use the supplied actual session directory captured from the active manager (including effective CLI overrides), rather than replacing it with `PI_CODING_AGENT_SESSION_DIR`. For separate offline scope, honor an explicitly supplied storage directory; use the default agent-directory sessions root only when appropriate. Ask for a directory/path if resolution is missing or ambiguous; do not scan the whole machine.

For each canonical file, record its session ID, cwd, format version, chosen branch/range, and fixed cutoff (bytes or last captured entry). Use exact paths and entry IDs/line numbers in citations. Label whether the audit covers the full recorded tree or a selected branch; do not silently treat file order as one conversation.

Inspect saved loadouts, registries, linkage, and completion/control artifacts only where needed. Prefer historical snapshots and persisted system/tool declarations over today's profiles. Record extension revision and model configuration only when evidenced; current checkout code is not proof of historical runtime behavior. Report truncated/malformed records and missing files. ID uniqueness requires a complete bounded search, even when diagnostics are omitted by the output cap.

## 2. Reconstruct the orchestration graph

Correlate spawn/resume/message/interrupt calls with their results and actual child files. Distinguish session ID, run ID, owner token, profile, and display name. Link descendants recursively using corroborated records; a parentSession link alone may describe a fork/clone, not a delegated task.

Group successive runs of the same session, but preserve individual run outcomes. Identify fork-seeded history: copied parent messages and usage are not new child work. Deduplicate overlapping input trees and inherited records; if kickoff/provenance cannot be established, report usage attribution as unknown rather than inventing totals. Unmatched records predating the child header remain unknown even when its purported parent is readable; retain independently corroborated seed matches.

Check routing, same-session joins, concurrent admissions, fallback, queued messages versus ingestion receipts, question replies, closure, and actual process-exit evidence. Successful tool acknowledgement is not task completion; delivery closure is not exit proof. Do not diagnose misrouting from a confusing name alone.

## 3. Extract bounded measurements

Start with the bundled deterministic analyzer described in ../INSTRUCTIONS.md. Use bounded local JSON parsing for evidence drilldown, not whole logs or repeated tool payloads. The analyzer follows header-corroborated registry children and valid extension-marker-owned artifact children. Transcript-only linkage needs separate read-only corroboration before inclusion, and must stay within the explicit/configured scope.

The current-session captured cutoff excludes this audit invocation. Historical audit-marker prefixes are untrusted data labeled through bounded counts/event references, not stop points: retain subsequent work and captured leaf ancestry. Prior audit activity remains in physical usage; full-turn boundaries and provider-cost exclusion cannot be deterministically inferred from a marker alone. Disclose that potential confounder.

Record where available:
- Parent versus child roles, models/thinking, new/resumed/forked runs, depth, and concurrency.
- Provider/SDK-recorded input, output, cache-read/write usage and recorded cost, separately by parent and descendants. Include non-message usage, compaction, and branch-summary usage when present. Missing/zero/unpriced cost is not proof of a free request.
- Request-level context indicators and compaction boundaries, separately from cumulative usage. Never equate summed input tokens, transcript bytes, or character estimates with peak context.
- Tool-result and handoff text sizes, repeated reads/searches, raw logs, and duplicate verification. Treat bytes/characters as text-volume metrics, not exact token counts.
- Wall-clock intervals and evidenced waits/questions/startup/fallback. Do not label an elapsed timer as continuous implementation or reviewer work.

Require branch-relative prompt/tool changes, compaction, and context-edit evidence before claiming model-visible context. The analyzer reports selected ancestry only and deliberately leaves actual provider-context size unknown; it does not attempt a speculative context replay. Distinguish physical-file accounting from selected-branch context. Count codemode wrapper calls separately from nested operations unless nested telemetry is recorded; source-code guesses are not exact invocation counts.

## 4. Interpret efficiency and reliability

Check whether tasks were bounded and self-contained; investigations stayed separate from editing; results were concise and useful; prerequisites preceded dependent work; file ownership and integration were coordinated; and current evidence replaced stale findings.

A repeated read may be necessary after an edit. A fresh child adds startup/handoff cost; a resume carries earlier context. Judge the tradeoff against actual task size, outcome, cache behavior, and authority. Retain full final-message transport; oversized reports suggest output-contract changes, not silent truncation.

Reproduce a suspected extension defect with a minimal offline fixture/harness only when verification is authorized and will not alter durable state. Otherwise give the reproduction plan and uncertainty. Never resume real audited sessions as a test.

## 5. Compare multiple sessions

Produce a compact per-session record before examining the next tree. Use identical metric definitions and report missing coverage. Compare task size/type, branch scope, extension revision, models, effective grants, session modes, and cache behavior; do not rank by raw token totals alone.

Separate recurring patterns from isolated failures. A clear reproduced correctness defect can justify a fix from one session; general efficiency policies need broader evidence. Recommend the smallest supported prompt/configuration/runtime change and a measurable follow-up check, not a new feature for every slow run.
