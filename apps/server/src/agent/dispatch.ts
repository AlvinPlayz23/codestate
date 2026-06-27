import type { ToolCall, ToolResult } from "@codestate/shared";
import type { CodestateTools } from "../tools/tools.js";
import type { ApprovalManager } from "./approvals.js";

const APPROVAL_REQUIRED = new Set<ToolCall["name"]>(["write", "apply", "run"]);

type DispatchDeps = {
  tools: CodestateTools;
  approvals: ApprovalManager;
};

/**
 * Run a single tool call, gating the mutating tools (write/apply/run) behind UI
 * approval unless `yolo` is set. Tool errors and rejections are returned as a
 * failed `ToolResult` rather than thrown, so the agent loop can feed them back
 * to the model and keep going.
 */
export async function executeTool(
  deps: DispatchDeps,
  sessionId: string,
  toolCall: ToolCall,
  yolo: boolean
): Promise<ToolResult> {
  try {
    if (!yolo && APPROVAL_REQUIRED.has(toolCall.name)) {
      let preview = previewToolCall(toolCall);
      if (toolCall.name === "apply") {
        try {
          const filePath = String(toolCall.input.path ?? "");
          const { content } = await deps.tools.read({ path: filePath });
          preview = buildApplyDiff(filePath, content, String(toolCall.input.find ?? ""), String(toolCall.input.replace ?? ""));
        } catch {
          // fall back to plain preview if file can't be read
        }
      }
      const approved = await deps.approvals.request(sessionId, toolCall, preview);
      if (!approved) return { callId: toolCall.id, ok: false, output: "User rejected this tool call." };
    }

    const output = await dispatchTool(deps.tools, toolCall);
    return { callId: toolCall.id, ok: true, output: JSON.stringify(output, null, 2) };
  } catch (error) {
    return { callId: toolCall.id, ok: false, output: error instanceof Error ? error.message : String(error) };
  }
}

function dispatchTool(tools: CodestateTools, toolCall: ToolCall) {
  switch (toolCall.name) {
    case "read":
      return tools.read({ path: String(toolCall.input.path ?? ".") });
    case "list":
      return tools.list({ path: String(toolCall.input.path ?? ".") });
    case "search":
      return tools.search({ query: String(toolCall.input.query ?? ""), path: String(toolCall.input.path ?? ".") });
    case "write":
      return tools.write({ path: String(toolCall.input.path ?? ""), content: String(toolCall.input.content ?? "") });
    case "apply":
      return tools.apply({
        path: String(toolCall.input.path ?? ""),
        find: String(toolCall.input.find ?? ""),
        replace: String(toolCall.input.replace ?? "")
      });
    case "run":
      return tools.run({ command: String(toolCall.input.command ?? "") });
  }
}

export function previewToolCall(toolCall: ToolCall): string {
  if (toolCall.name === "run") return `$ ${String(toolCall.input.command ?? "")}`;
  if (toolCall.name === "write") return `Write ${String(toolCall.input.path ?? "")}\n\n${String(toolCall.input.content ?? "")}`;
  if (toolCall.name === "apply") {
    return `Apply edit to ${String(toolCall.input.path ?? "")}\n\nFind:\n${String(toolCall.input.find ?? "")}\n\nReplace:\n${String(toolCall.input.replace ?? "")}`;
  }
  return JSON.stringify(toolCall.input, null, 2);
}

export function buildApplyDiff(filePath: string, content: string, find: string, replace: string): string {
  const idx = content.indexOf(find);
  if (idx === -1) return previewToolCall({ id: "", name: "apply", input: { path: filePath, find, replace } });

  const beforeLines = content.slice(0, idx).split("\n");
  const findLines = find.split("\n");
  const replaceLines = replace.split("\n");
  const startLine = beforeLines.length;

  // 3 lines of context before and after
  const contextBefore = content.slice(0, idx).split("\n").slice(-3);
  const contextAfter = content.slice(idx + find.length).split("\n").slice(0, 3);

  const hunkLines: string[] = [
    `--- ${filePath}`,
    `+++ ${filePath}`,
    `@@ -${startLine},${findLines.length + contextBefore.length} +${startLine},${replaceLines.length + contextBefore.length} @@`,
    ...contextBefore.map((l) => ` ${l}`),
    ...findLines.map((l) => `-${l}`),
    ...replaceLines.map((l) => `+${l}`),
    ...contextAfter.map((l) => ` ${l}`)
  ];

  return hunkLines.join("\n");
}
