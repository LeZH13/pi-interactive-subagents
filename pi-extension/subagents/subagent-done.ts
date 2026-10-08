/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+Alt+O)
 * - Provides an `ask_question` tool for asking the parent orchestrator a question
 *
 * Subagents do NOT self-terminate via a tool. Auto-exit agents shut down
 * automatically when their run fully settles (see the `agent_settled` handler);
 * interactive agents end when the human exits the pane.
 *
 * `ask_question` keeps the session OPEN: it writes a `${sessionFile}.ask`
 * signal the parent's watcher picks up and awaits the answer inside the tool.
 * The parent's next current-run steer (or human input) resolves the tool with
 * the answer, without queueing a duplicate message or starting another turn.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { unlinkSync, writeFileSync } from "node:fs";
import { drainInbox, openSession, validateChildOwner, reopenSessionDelivery, retrySessionOperation, SessionBusyError, type InboxMessage } from "./protocol.ts";
import { bashGuardReady } from "./bash-guard.ts";
import {
  createSubagentActivityRecorder,
  type SubagentTelemetry,
} from "./activity.ts";

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Extract the model and latest usage snapshot from an assistant message. */
export function telemetryFromMessage(message: unknown): SubagentTelemetry | undefined {
  if (message == null || typeof message !== "object" || (message as any).role !== "assistant") return undefined;
  const assistant = message as Record<string, unknown>;
  const telemetry: SubagentTelemetry = {};
  const model = typeof assistant.model === "string" ? assistant.model.trim() : "";
  if (model) telemetry.model = model;

  const usage = assistant.usage;
  if (usage != null && typeof usage === "object" && !Array.isArray(usage)) {
    const values = usage as Record<string, unknown>;
    const input = finiteNonNegative(values.input);
    const output = finiteNonNegative(values.output);
    const cacheRead = finiteNonNegative(values.cacheRead);
    const cacheWrite = finiteNonNegative(values.cacheWrite);
    const contextTokens = finitePositive(values.totalTokens);
    const costObj = values.cost;
    const cost = costObj != null && typeof costObj === "object" && !Array.isArray(costObj)
      ? finiteNonNegative((costObj as Record<string, unknown>).total)
      : undefined;

    const hasAnyUsage = (input != null && input > 0) ||
      (output != null && output > 0) ||
      (cacheRead != null && cacheRead > 0) ||
      (cacheWrite != null && cacheWrite > 0) ||
      (contextTokens != null && contextTokens > 0) ||
      (cost != null && cost > 0);

    if (hasAnyUsage) {
      if (input != null) telemetry.inputTokens = input;
      if (output != null) telemetry.outputTokens = output;
      if (cacheRead != null) telemetry.cacheReadTokens = cacheRead;
      if (cacheWrite != null) telemetry.cacheWriteTokens = cacheWrite;
      if (contextTokens != null) telemetry.contextTokens = contextTokens;
      if (cost != null) telemetry.cost = cost;
    }
  }

  return Object.values(telemetry).some((value) => value != null) ? telemetry : undefined;
}

/** Fill model/context metadata from Pi's lifecycle context when available. */
export function telemetryFromContext(ctx: unknown): SubagentTelemetry | undefined {
  if (ctx == null || typeof ctx !== "object") return undefined;
  const context = ctx as Record<string, any>;
  const telemetry: SubagentTelemetry = {};
  const model = typeof context.model?.id === "string" ? context.model.id.trim() : "";
  if (model) telemetry.model = model;
  const thinking = typeof context.thinkingLevel === "string" ? context.thinkingLevel.trim() : "";
  if (thinking) telemetry.thinking = thinking;
  if (typeof context.getContextUsage === "function") {
    try {
      const usage = context.getContextUsage();
      const tokens = finitePositive(usage?.tokens);
      if (tokens != null) telemetry.contextTokens = tokens;
    } catch {
      // Telemetry is best effort and must never disrupt the subagent lifecycle.
    }
  }
  return Object.values(telemetry).some((value) => value != null) ? telemetry : undefined;
}

export function mergeTelemetry(
  contextTelemetry: SubagentTelemetry | undefined,
  messageTelemetry: SubagentTelemetry | undefined,
): SubagentTelemetry | undefined {
  if (!contextTelemetry && !messageTelemetry) return undefined;
  const merged: SubagentTelemetry = { ...contextTelemetry };
  if (!messageTelemetry) return merged;
  for (const [key, value] of Object.entries(messageTelemetry)) {
    if (value !== undefined) {
      (merged as any)[key] = value;
    }
  }
  return merged;
}

function lifecycleTelemetry(message: unknown, ctx: unknown): SubagentTelemetry | undefined {
  return mergeTelemetry(telemetryFromContext(ctx), telemetryFromMessage(message));
}

function latestAssistantMessage(messages: unknown[] | undefined): unknown {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    if ((messages[index] as any)?.role === "assistant") return messages[index];
  }
  return undefined;
}

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

/**
 * Number of child subagents this session itself still has in flight.
 *
 * When this extension is loaded inside a subagent that can spawn its own
 * children (e.g. a worker delegating to scout/researcher), `index.ts` runs in
 * the same process and publishes a live count through a shared process-global
 * symbol. A subagent that spawns children and then writes a "waiting for
 * results" message would otherwise auto-exit the instant that turn ends —
 * killing the session before its children report back. Reading this count lets
 * `agent_settled` keep the session open until every child has finished and its
 * result has been delivered.
 *
 * Returns 0 when the spawning tools aren't loaded (scout/researcher, or a
 * standalone session), so those agents auto-exit exactly as before.
 */
export function runningChildrenCount(): number {
  const fn = (globalThis as any)[Symbol.for("pi-subagents/running-children-count")];
  if (typeof fn !== "function") return 0;
  try {
    const n = fn();
    return typeof n === "number" && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function shouldAutoExitOnAgentSettled(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentSettled).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export default async function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+Alt+O to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  const sessionFile = process.env.PI_SUBAGENT_SESSION;
  const identity = { runId: process.env.PI_SUBAGENT_RUN_ID ?? "", ownerToken: process.env.PI_SUBAGENT_OWNER_TOKEN ?? "" };
  if (sessionFile) {
    try { validateChildOwner(sessionFile, identity); }
    catch (error) {
      if (!(error instanceof SessionBusyError)) throw error;
      await retrySessionOperation(() => validateChildOwner(sessionFile, identity));
    }
  }
  let deliveryClosed = false;
  let latestContext: import("@earendil-works/pi-coding-agent").ExtensionContext | undefined;
  let deliveryFailure: string | undefined;
  let boundaryExitRequested = false;
  let idleExit: { messages: any[]; telemetry: SubagentTelemetry | undefined;
    ctx: import("@earendil-works/pi-coding-agent").ExtensionContext } | undefined;

  let userTookOver = false;
  let agentStarted = false;
  let runOpen = false;
  let runCancelled = false;
  let runAssistantMessage: unknown;
  let steerInterval: ReturnType<typeof setInterval> | null = null;

  let pendingQuestion: {
    answer(message: string): void;
    cancel(message: string): void;
  } | undefined;
  let shuttingDown = false;

  function answerPendingQuestion(message: string): boolean {
    if (!pendingQuestion || !message) return false;
    pendingQuestion.answer(message);
    return true;
  }

  function deliverSteer(item: InboxMessage): "question" | "queued" {
    if (answerPendingQuestion(item.body)) return "question";
    pi.sendMessage(
      { customType: "subagent_steer", content: item.body, display: true,
        details: { messageId: item.messageId, runId: item.runId, deliveryRunId: identity.runId } },
      { triggerTurn: true, deliverAs: "steer" },
    );
    // sendMessage returns void. Only the persisted branch can confirm ingestion.
    return "queued";
  }

  function checkPendingSteerMessage(close = false) {
    if (!sessionFile || !latestContext || deliveryClosed || shuttingDown) return;
    try {
      const result = drainInbox(sessionFile, identity, {
        branch: latestContext.sessionManager.getBranch(), deliver: deliverSteer, close,
      });
      deliveryClosed = result.closed;
      deliveryFailure = undefined;
      return result;
    } catch (error) {
      // Retain every item and keep delivery open. A transient mutex collision can retry next poll.
      deliveryFailure = String(error);
      if (!(error instanceof SessionBusyError)) latestContext.ui.notify(`Subagent delivery stalled: ${String(error)}`, "error");
    }
  }

  function clearExitIntent() {
    idleExit = undefined;
    boundaryExitRequested = false;
    if (!pendingQuestion) steerInterval?.unref();
  }

  function finishAutoExit(messages: any[], telemetry: SubagentTelemetry | undefined,
    ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) {
    clearExitIntent();
    const errorInfo = findLatestAssistantError(messages);
    if (errorInfo && sessionFile) {
      try {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage: errorInfo.errorMessage,
          stopReason: errorInfo.stopReason, ...identity, createdAt: Date.now() }));
      } catch { /* The finalized transcript still contains the full provider error. */ }
    }
    recorder.agentSettledDone(telemetry);
    ctx.shutdown();
  }

  function pollDelivery() {
    const intent = idleExit;
    const mayFinish = !!intent && !!latestContext?.isIdle() && !pendingQuestion && !runCancelled && runningChildrenCount() === 0;
    const result = checkPendingSteerMessage(mayFinish);
    // Resume only the exit intent authorized by the actionable boundary. No new prompt/provider request is needed for a late ACK or released mutex.
    if (intent && idleExit === intent && mayFinish && result?.closed) finishAutoExit(intent.messages, intent.telemetry, intent.ctx);
  }

  function requireBashGuard(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext): boolean {
    if (!pi.getAllTools().some((tool) => tool.name === "bash") || bashGuardReady()) return true;
    const errorMessage = "Cannot start bash-enabled subagent: bash-guard did not initialize in enforced deny mode. Check its installation and extension errors.";
    if (sessionFile) {
      try {
        writeFileSync(`${sessionFile}.exit`, JSON.stringify({ type: "error", errorMessage,
          stopReason: "error", ...identity, createdAt: Date.now() }));
      } catch { /* Diagnostic persistence must never prevent shutdown or tool blocking. */ }
    }
    ctx.shutdown();
    return false;
  }

  // Show widget + status bar only after child ownership has been validated and opened.
  function startSession(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) {
    if (!requireBashGuard(ctx)) return;
    shuttingDown = false;
    latestContext = ctx;
    recorder.sessionStart(telemetryFromContext(ctx));
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);

    if (!steerInterval) {
      steerInterval = setInterval(pollDelivery, 500);
      if (typeof steerInterval?.unref === "function") {
        steerInterval.unref();
      }
    }
  }
  pi.on("session_start", (_event, ctx) => {
    if (sessionFile) {
      try { openSession(sessionFile, identity); }
      catch (error) {
        if (!(error instanceof SessionBusyError)) { ctx.shutdown(); throw error; }
        return retrySessionOperation(() => openSession(sessionFile, identity)).then(() => startSession(ctx))
          .catch((failure) => { ctx.shutdown(); throw failure; });
      }
    }
    startSession(ctx);
  });

  pi.on("input", (event) => {
    recorder.input();
    // sendMessage custom steers do not emit input; the queue handles those.
    // Human input can also answer, but must not become a second queued prompt.
    const answered = answerPendingQuestion(event.text.trim());
    if (shouldMarkUserTookOver(agentStarted)) userTookOver = true;
    if (answered) return { action: "handled" };
  });

  pi.on("before_agent_start", (_event, ctx) => {
    if (!requireBashGuard(ctx)) return;
    clearExitIntent();
    runCancelled = false;
    runAssistantMessage = undefined;
    recorder.beforeAgentStart(telemetryFromContext(ctx));
  });

  function startRun(ctx: import("@earendil-works/pi-coding-agent").ExtensionContext) {
    if (!requireBashGuard(ctx)) return;
    clearExitIntent();
    deliveryClosed = false;
    agentStarted = true;
    // Retry/compaction/queued continuations start more loops in the same run.
    // Only a fresh run resets message freshness. A question is cleared only
    // by its actual reply or cancellation, never by an assumed input event.
    // This also covers sendMessage-triggered runs without before_agent_start.
    if (!runOpen) {
      runCancelled = false;
      runAssistantMessage = undefined;
      runOpen = true;
    }
    recorder.agentStart(telemetryFromContext(ctx));
  }
  pi.on("agent_start", (_event, ctx) => {
    if (deliveryClosed && sessionFile) {
      try { reopenSessionDelivery(sessionFile, identity); }
      catch (error) {
        if (!(error instanceof SessionBusyError)) { ctx.shutdown(); throw error; }
        return retrySessionOperation(() => reopenSessionDelivery(sessionFile, identity)).then(() => startRun(ctx))
          .catch((failure) => { ctx.shutdown(); throw failure; });
      }
    }
    startRun(ctx);
  });

  pi.on("message_end", (event) => {
    if (event.message.role === "assistant") runAssistantMessage = event.message;
  });

  pi.on("agent_end", (event, ctx) => {
    // A loop ending is not final: Pi may retry, compact, drain queues, or
    // continue from agent_before_settle. Keep recording until settlement.
    recorder.agentEnd(lifecycleTelemetry(latestAssistantMessage(event.messages), ctx));
  });

  pi.on("agent_before_settle", (event, ctx) => {
    latestContext = ctx;
    const messages = runAssistantMessage ? [runAssistantMessage] : [];
    const mayClose = autoExit && event.outcome !== "aborted" && !pendingQuestion && !runCancelled && runningChildrenCount() === 0 &&
      shouldAutoExitOnAgentSettled(userTookOver, messages);
    boundaryExitRequested = mayClose;
    const result = checkPendingSteerMessage(mayClose && !event.continue && event.context.pendingMessages.length === 0);
    if (result?.pending.length && event.context.canContinue &&
        (result.dispatched > 0 || event.context.pendingMessages.length > 0)) {
      return { continue: true };
    }
    // Pending ACKs or delivery errors park the child rather than pretending it drained its inbox.
  });

  pi.on("agent_settled", (_event, ctx) => {
    // The event has no messages. Use only messages finalized in this run,
    // never an older assistant from a resumed session's branch.
    const messages = runAssistantMessage ? [runAssistantMessage] : [];
    const telemetry = lifecycleTelemetry(runAssistantMessage, ctx);
    runOpen = false;
    runAssistantMessage = undefined;
    // Never shut down while this session still has work in flight:
    //  - pendingQuestion: an ask_question is pending the orchestrator's reply.
    //  - runningChildrenCount(): this subagent spawned its own children and is
    //    waiting for their results (delivered as steered turns). Exiting now
    //    would strand those children and drop their results.
    // In both cases the session parks as `waiting` and resumes when the next
    // turn lands.
    const hasPendingChildren = runningChildrenCount() > 0;
    const shouldExit =
      !pendingQuestion &&
      !runCancelled &&
      !hasPendingChildren &&
      autoExit &&
      (!sessionFile || boundaryExitRequested) &&
      (!sessionFile || deliveryClosed) &&
      !deliveryFailure &&
      shouldAutoExitOnAgentSettled(userTookOver, messages);

    if (shouldExit) {
      finishAutoExit(messages, telemetry, ctx);
      return;
    }
    if (boundaryExitRequested && autoExit && !pendingQuestion && !runCancelled && !hasPendingChildren) {
      idleExit = { messages, telemetry, ctx };
      steerInterval?.ref(); // Keep headless children alive while reconciling a delayed receipt/lock.
    }

    recorder.agentSettledWaiting(telemetry);
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event, ctx) => {
    recorder.turnStart((event as any).turnIndex, telemetryFromContext(ctx));
  });

  pi.on("turn_end", (event, ctx) => {
    recorder.turnEnd(
      (event as any).turnIndex,
      lifecycleTelemetry((event as any).message, ctx),
    );
  });

  pi.on("before_provider_request", (_event, ctx) => {
    recorder.beforeProviderRequest(telemetryFromContext(ctx));
  });

  pi.on("after_provider_response", (_event, ctx) => {
    recorder.afterProviderResponse(telemetryFromContext(ctx));
  });

  pi.on("message_update", (event, ctx) => {
    recorder.messageUpdate(
      (event as any).assistantMessageEvent?.type,
      lifecycleTelemetry((event as any).message, ctx),
    );
  });

  pi.on("thinking_level_select", (event, ctx) => {
    const level = (event as any)?.level;
    const telemetry = telemetryFromContext(ctx) ?? {};
    if (typeof level === "string" && level.trim()) telemetry.thinking = level.trim();
    recorder.syncTelemetry(telemetry);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!requireBashGuard(ctx)) return { block: true, reason: "Required bash-guard is not ready in enforced deny mode." };
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event) => {
    shuttingDown = true;
    clearExitIntent();
    pendingQuestion?.cancel("ask_question cancelled: session shutdown.");
    if (steerInterval) {
      clearInterval(steerInterval);
      steerInterval = null;
    }
    recorder.sessionShutdown((event as any).reason);
    // Completion authority belongs to the outer launch wrapper, which runs
    // only after Pi and every awaited shutdown hook have actually exited.
  });

  // Toggle expand/collapse with Ctrl+Alt+O
  pi.registerShortcut("ctrl+alt+o", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "ask_question",
    label: "ask_question",
    description:
      "Ask the orchestrator (the parent agent that spawned you) a single question and pause until they reply. " +
      "Use this when requirements are ambiguous, a decision would materially affect your work, you're blocked, " +
      "or you need information or confirmation only the orchestrator has. Prefer asking over guessing. " +
      "The tool waits and returns their answer before you continue. " +
      "Ask exactly one question per call; make separate calls for unrelated questions.",
    promptSnippet:
      "Use this tool to ask the orchestrator one clarifying, missing-requirement, preference, or decision question before continuing — instead of guessing.",
    promptGuidelines: [
      "Ask exactly one question per tool call.",
      "If you need answers to multiple things, make separate ask_question calls instead of bundling them.",
      "Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
      "Use it when multiple valid paths exist and the right one depends on the orchestrator's intent.",
      "Give enough context in the question that the orchestrator can answer without re-reading your whole task.",
      "The tool pauses execution until the reply arrives; continue only after it returns the answer.",
    ],
    parameters: Type.Object({
      question: Type.String({
        description:
          "The single freeform question to ask the orchestrator. Include enough context to answer it directly.",
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "ask_question is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      if (pendingQuestion) {
        throw new Error("ask_question already has a pending question.");
      }
      const operationSignal = signal ?? ctx.signal;
      const cancellation = (message: string) => {
        const error = new Error(message);
        error.name = "AbortError";
        return error;
      };
      if (shuttingDown) throw cancellation("ask_question cancelled: session shutdown.");
      if (operationSignal?.aborted) {
        runCancelled = true;
        throw cancellation("ask_question cancelled.");
      }

      // Blocking the tool also blocks the next provider request. Register the
      // waiter before publishing so even an immediate parent reply is consumed.
      const answer = await new Promise<string>((resolve, reject) => {
        const askFile = `${sessionFile}.ask`;
        const cleanup = () => {
          pendingQuestion = undefined;
          steerInterval?.unref();
          operationSignal?.removeEventListener("abort", onAbort);
          try { unlinkSync(askFile); } catch {}
        };
        const onAbort = () => {
          // An aborted tool wait may leave the last assistant at toolUse, not
          // aborted. Settlement must still park rather than treating it as done.
          runCancelled = true;
          pendingQuestion?.cancel("ask_question cancelled.");
        };
        pendingQuestion = {
          answer(message) {
            cleanup();
            resolve(message);
          },
          cancel(message) {
            cleanup();
            reject(cancellation(message));
          },
        };
        // An unresolved Promise alone does not keep headless Node alive.
        // Keep polling referenced only while its answer is needed.
        steerInterval?.ref();
        operationSignal?.addEventListener("abort", onAbort, { once: true });
        try {
          recorder.askQuestion();
          writeFileSync(askFile, JSON.stringify({
            name: process.env.PI_SUBAGENT_NAME ?? "subagent",
            agent: process.env.PI_SUBAGENT_AGENT ?? "",
            question: params.question,
            runId: process.env.PI_SUBAGENT_RUN_ID,
            createdAt: Date.now(),
          }));
        } catch (error) {
          cleanup();
          reject(error);
        }
      });

      return {
        content: [{ type: "text", text: answer }],
        details: { question: params.question, answer },
      };
    },

    renderCall(args, theme) {
      const text =
        theme.fg("toolTitle", theme.bold("ask_question ")) +
        theme.fg("muted", String((args as any).question ?? ""));
      return new Text(text, 0, 0);
    },
  });

}
