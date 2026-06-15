import { systemPrompt, type OpenAIMessage } from "../model/openai.js";

// Shown to the model in place of a real tool result when a turn is interrupted
// (stopped, errored, or step-capped) before the tool produced output.
const INTERRUPTED_TOOL_OUTPUT = "Tool call interrupted before it produced a result.";

/**
 * Build the working history for a turn from the session's stored history, or a
 * fresh system prompt for a brand-new session. The stored history is repaired
 * on the way in so a turn that was interrupted last time can be safely resumed.
 */
export function buildHistory(stored: OpenAIMessage[]): OpenAIMessage[] {
  const history: OpenAIMessage[] = stored.length > 0 ? [...stored] : [{ role: "system", content: systemPrompt }];
  backfillPendingToolResults(history);
  return history;
}

export function normalizeAssistantMessage(message: OpenAIMessage): OpenAIMessage {
  if (message.role !== "assistant") return message;

  // Providers reject assistant tool-call turns whose content is null on the
  // following request, so it is normalized to an empty string.
  return {
    role: "assistant",
    content: message.content ?? "",
    tool_calls: message.tool_calls
  };
}

/**
 * OpenAI-compatible APIs reject an assistant message that requests tool calls
 * unless every tool_call_id is answered by a following `tool` message. When a
 * turn is interrupted mid-tool, the history we persist can be missing some of
 * those answers; this fills them in with a placeholder so the saved (and later
 * resumed) history is always a valid request. Mutates `history` in place.
 */
export function backfillPendingToolResults(history: OpenAIMessage[]): void {
  const resolved = new Set<string>();
  for (const message of history) {
    if (message.role === "tool" && message.tool_call_id) resolved.add(message.tool_call_id);
  }

  const pending: string[] = [];
  for (const message of history) {
    if (message.role !== "assistant" || !message.tool_calls) continue;
    for (const call of message.tool_calls) {
      if (!resolved.has(call.id) && !pending.includes(call.id)) pending.push(call.id);
    }
  }

  for (const id of pending) {
    history.push({ role: "tool", tool_call_id: id, content: INTERRUPTED_TOOL_OUTPUT });
  }
}
