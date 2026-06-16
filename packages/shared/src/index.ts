export type Role = "user" | "assistant" | "system" | "tool";

export type ToolName = "read" | "list" | "search" | "write" | "apply" | "run";

export type ChatMessage = {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
};

export type ToolCall = {
  id: string;
  name: ToolName;
  input: Record<string, unknown>;
};

export type ToolResult = {
  callId: string;
  ok: boolean;
  output: string;
};

export type ApprovalRequest = {
  id: string;
  toolCall: ToolCall;
  preview: string;
  createdAt: number;
};

export type TimelineItem =
  | { type: "message"; message: ChatMessage }
  | { type: "tool"; call: ToolCall; result?: ToolResult }
  | { type: "approval"; request: ApprovalRequest; resolved?: boolean; stale?: boolean };

export type SessionSummary = {
  id: string;
  title: string;
  projectRoot: string;
  model: string;
  createdAt: number;
  updatedAt: number;
};

export type StoredSession = SessionSummary & {
  modelHistory: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content: string | null;
    tool_call_id?: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  timeline: TimelineItem[];
};

export type ServerEvent =
  | { type: "message.delta"; sessionId: string; content: string }
  | { type: "message.done"; sessionId: string; message: ChatMessage }
  | { type: "tool.started"; sessionId: string; toolCall: ToolCall }
  | { type: "tool.output"; sessionId: string; result: ToolResult }
  | { type: "approval.requested"; sessionId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; sessionId: string; approvalId: string; approved: boolean }
  | { type: "session.error"; sessionId: string; message: string };

export type ChatRequest = {
  sessionId?: string;
  message: string;
  displayMessage?: string;
  yolo?: boolean;
};

export type ChatResponse = {
  sessionId: string;
};
