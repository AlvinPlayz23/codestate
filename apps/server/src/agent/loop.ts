import type { ChatMessage, TimelineItem } from "@codestate/shared";
import { completeWithTools } from "../model/openai.js";
import { createApprovalManager } from "./approvals.js";
import { executeTool } from "./dispatch.js";
import { backfillPendingToolResults, buildHistory, normalizeAssistantMessage } from "./history.js";
import type { AgentOptions } from "./types.js";

// Hard cap on tool steps per prompt, to stop runaway loops.
const MAX_TOOL_STEPS = 450;

type TurnDeps = AgentOptions & {
  approvals: ReturnType<typeof createApprovalManager>;
};

/**
 * Run one user turn: append the message, then loop model call -> tool calls
 * until the model answers with no tools, the step cap is hit, the turn errors,
 * or the user aborts.
 *
 * The model history is persisted at every checkpoint (after the user message,
 * after each assistant reply, after each tool result) and on every exit path.
 * This is what lets a stopped or interrupted turn be resumed with full context:
 * the timeline alone is not enough, because only `modelHistory` is replayed to
 * the model on the next turn.
 */
export async function runTurn(
  deps: TurnDeps,
  sessionId: string,
  userMessage: string,
  yolo: boolean,
  signal: AbortSignal,
  displayMessage = userMessage
): Promise<void> {
  const { store, events, tools, approvals } = deps;

  let session = await store.get(sessionId);
  if (!session) {
    session = await store.create({
      id: sessionId,
      projectRoot: deps.projectRoot,
      model: deps.model,
      title: displayMessage.split("\n")[0].slice(0, 60)
    });
  }

  const history = buildHistory(session.modelHistory);
  const persist = () => store.saveModelHistory(sessionId, history);

  // Repair any dangling tool calls, persist, and tell the UI why we stopped.
  const stop = async (message: string) => {
    backfillPendingToolResults(history);
    await persist();
    events.emit({ type: "session.error", sessionId, message });
  };

  history.push({ role: "user", content: userMessage });

  const userTimeline: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: displayMessage,
    createdAt: Date.now()
  };
  await store.appendTimeline(sessionId, { type: "message", message: userTimeline });

  if (session.timeline.length <= 1 && session.title === "New session") {
    await store.updateTitle(sessionId, displayMessage.split("\n")[0].slice(0, 60));
  }

  // Persist the user turn immediately so it survives an interruption that lands
  // before the model has replied.
  await persist();

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      if (signal.aborted) return stop("Agent stopped by user.");

      const response = await completeWithTools(history);
      history.push(normalizeAssistantMessage(response.rawMessage));
      await persist();

      if (response.content) {
        events.emit({ type: "message.delta", sessionId, content: response.content });
      }

      if (response.toolCalls.length === 0) {
        const message: ChatMessage = {
          id: crypto.randomUUID(),
          role: "assistant",
          content: response.content,
          createdAt: Date.now()
        };
        await store.appendTimeline(sessionId, { type: "message", message });
        await persist();
        events.emit({ type: "message.done", sessionId, message });
        return;
      }

      for (const toolCall of response.toolCalls) {
        if (signal.aborted) return stop("Agent stopped by user.");

        const toolItem: TimelineItem = { type: "tool", call: toolCall };
        await store.appendTimeline(sessionId, toolItem);
        events.emit({ type: "tool.started", sessionId, toolCall });

        const result = await executeTool({ tools, approvals }, sessionId, toolCall, yolo);
        await store.updateTimelineItem(
          sessionId,
          (item) => item.type === "tool" && item.call.id === toolCall.id,
          (item) => (item.type === "tool" ? { ...item, result } : item)
        );
        events.emit({ type: "tool.output", sessionId, result });

        history.push({ role: "tool", tool_call_id: toolCall.id, content: result.output });
        await persist();
      }
    }

    await stop("Agent stopped after too many tool steps. Try a narrower prompt.");
  } catch (error) {
    if (signal.aborted) {
      await stop("Agent stopped by user.");
      return;
    }
    backfillPendingToolResults(history);
    await persist();
    events.emit({
      type: "session.error",
      sessionId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}
