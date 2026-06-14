import type { ApprovalRequest, ChatMessage, ServerEvent, TimelineItem, ToolCall, ToolResult } from "@codestate/shared";
import type { EventBus } from "../events.js";
import { completeWithTools, systemPrompt, type OpenAIMessage } from "../model/openai.js";
import type { JsonSessionStore } from "../sessions/store.js";
import type { CodestateTools } from "../tools/tools.js";

type AgentOptions = {
  projectRoot: string;
  model: string;
  events: EventBus;
  tools: CodestateTools;
  store: JsonSessionStore;
};

type PendingApproval = {
  sessionId: string;
  resolve: (approved: boolean) => void;
};

export function createAgent(options: AgentOptions) {
  const pendingApprovals = new Map<string, PendingApproval>();
  const abortControllers = new Map<string, AbortController>();

  async function run(sessionId: string, userMessage: string) {
    const controller = new AbortController();
    abortControllers.set(sessionId, controller);

    try {
      let session = await options.store.get(sessionId);
      if (!session) {
        session = await options.store.create({
          id: sessionId,
          projectRoot: options.projectRoot,
          model: options.model,
          title: userMessage.split("\n")[0].slice(0, 60)
        });
      }

      let history: OpenAIMessage[] = session.modelHistory.length > 0
        ? session.modelHistory
        : [{ role: "system", content: systemPrompt }];

      const userMsg: OpenAIMessage = { role: "user", content: userMessage };
      history.push(userMsg);

      const userTimeline: ChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: userMessage,
        createdAt: Date.now()
      };
      await options.store.appendTimeline(sessionId, { type: "message", message: userTimeline });

      if (session.timeline.length <= 1 && session.title === "New session") {
        await options.store.updateTitle(sessionId, userMessage.split("\n")[0].slice(0, 60));
      }

      for (let step = 0; step < 450; step += 1) {
        if (controller.signal.aborted) {
          emit(options.events, { type: "session.error", sessionId, message: "Agent stopped by user." });
          return;
        }

        const response = await completeWithTools(history);
        history.push(normalizeAssistantMessage(response.rawMessage));

        if (response.content) {
          emit(options.events, { type: "message.delta", sessionId, content: response.content });
        }

        if (response.toolCalls.length === 0) {
          const message: ChatMessage = {
            id: crypto.randomUUID(),
            role: "assistant",
            content: response.content,
            createdAt: Date.now()
          };
          await options.store.appendTimeline(sessionId, { type: "message", message });
          await options.store.saveModelHistory(sessionId, history);
          emit(options.events, { type: "message.done", sessionId, message });
          return;
        }

        for (const toolCall of response.toolCalls) {
          if (controller.signal.aborted) {
            emit(options.events, { type: "session.error", sessionId, message: "Agent stopped by user." });
            return;
          }

          const toolItem: TimelineItem = { type: "tool", call: toolCall };
          await options.store.appendTimeline(sessionId, toolItem);
          emit(options.events, { type: "tool.started", sessionId, toolCall });

          const result = await executeTool(sessionId, toolCall);
          await options.store.updateTimelineItem(
            sessionId,
            (item) => item.type === "tool" && item.call.id === toolCall.id,
            (item) => (item.type === "tool" ? { ...item, result } : item)
          );
          emit(options.events, { type: "tool.output", sessionId, result });
          history.push({ role: "tool", tool_call_id: toolCall.id, content: result.output });
        }
      }

      emit(options.events, {
        type: "session.error",
        sessionId,
        message: "Agent stopped after too many tool steps. Try a narrower prompt."
      });
    } catch (error) {
      if (controller.signal.aborted) {
        emit(options.events, { type: "session.error", sessionId, message: "Agent stopped by user." });
      } else {
        emit(options.events, {
          type: "session.error",
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    } finally {
      abortControllers.delete(sessionId);
    }
  }

  function abort(sessionId: string) {
    const controller = abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      abortControllers.delete(sessionId);
    }

    for (const [id, pending] of pendingApprovals) {
      if (pending.sessionId === sessionId) {
        pendingApprovals.delete(id);
        pending.resolve(false);
        emit(options.events, { type: "approval.resolved", sessionId, approvalId: id, approved: false });
      }
    }
  }

  async function executeTool(sessionId: string, toolCall: ToolCall): Promise<ToolResult> {
    try {
      if (toolCall.name === "write" || toolCall.name === "apply" || toolCall.name === "run") {
        const approved = await requestApproval(sessionId, toolCall, previewToolCall(toolCall));
        if (!approved) return { callId: toolCall.id, ok: false, output: "User rejected this tool call." };
      }

      const output = await dispatchTool(toolCall);
      return { callId: toolCall.id, ok: true, output: JSON.stringify(output, null, 2) };
    } catch (error) {
      return { callId: toolCall.id, ok: false, output: error instanceof Error ? error.message : String(error) };
    }
  }

  async function dispatchTool(toolCall: ToolCall) {
    switch (toolCall.name) {
      case "read":
        return options.tools.read({ path: String(toolCall.input.path ?? ".") });
      case "list":
        return options.tools.list({ path: String(toolCall.input.path ?? ".") });
      case "search":
        return options.tools.search({ query: String(toolCall.input.query ?? ""), path: String(toolCall.input.path ?? ".") });
      case "write":
        return options.tools.write({ path: String(toolCall.input.path ?? ""), content: String(toolCall.input.content ?? "") });
      case "apply":
        return options.tools.apply({
          path: String(toolCall.input.path ?? ""),
          find: String(toolCall.input.find ?? ""),
          replace: String(toolCall.input.replace ?? "")
        });
      case "run":
        return options.tools.run({ command: String(toolCall.input.command ?? "") });
    }
  }

  function requestApproval(sessionId: string, toolCall: ToolCall, preview: string) {
    const request: ApprovalRequest = { id: crypto.randomUUID(), toolCall, preview, createdAt: Date.now() };
    emit(options.events, { type: "approval.requested", sessionId, request });

    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(request.id, { sessionId, resolve });
    });
  }

  function resolveApproval(approvalId: string, approved: boolean) {
    const pending = pendingApprovals.get(approvalId);
    if (!pending) return false;
    pendingApprovals.delete(approvalId);
    pending.resolve(approved);
    emit(options.events, { type: "approval.resolved", sessionId: pending.sessionId, approvalId, approved });
    return true;
  }

  return { run, abort, resolveApproval };
}

function previewToolCall(toolCall: ToolCall) {
  if (toolCall.name === "run") return `$ ${String(toolCall.input.command ?? "")}`;
  if (toolCall.name === "write") return `Write ${String(toolCall.input.path ?? "")}\n\n${String(toolCall.input.content ?? "")}`;
  if (toolCall.name === "apply") {
    return `Apply edit to ${String(toolCall.input.path ?? "")}\n\nFind:\n${String(toolCall.input.find ?? "")}\n\nReplace:\n${String(toolCall.input.replace ?? "")}`;
  }
  return JSON.stringify(toolCall.input, null, 2);
}

function emit(events: EventBus, event: ServerEvent) {
  events.emit(event);
}

function normalizeAssistantMessage(message: OpenAIMessage): OpenAIMessage {
  if (message.role !== "assistant") return message;

  return {
    role: "assistant",
    content: message.content ?? "",
    tool_calls: message.tool_calls
  };
}
