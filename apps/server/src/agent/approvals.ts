import type { ApprovalRequest, ToolCall } from "@codestate/shared";
import type { EventBus } from "../events.js";

type PendingApproval = {
  sessionId: string;
  resolve: (approved: boolean) => void;
};

/**
 * Tracks tool-call approvals that are awaiting a decision from the browser UI.
 * `request` returns a promise that resolves when the user responds (or when the
 * session is aborted, in which case it resolves to `false`).
 */
export function createApprovalManager(events: EventBus) {
  const pending = new Map<string, PendingApproval>();

  function request(sessionId: string, toolCall: ToolCall, preview: string): Promise<boolean> {
    const approval: ApprovalRequest = { id: crypto.randomUUID(), toolCall, preview, createdAt: Date.now() };
    events.emit({ type: "approval.requested", sessionId, request: approval });

    return new Promise<boolean>((resolve) => {
      pending.set(approval.id, { sessionId, resolve });
    });
  }

  function resolve(approvalId: string, approved: boolean): boolean {
    const entry = pending.get(approvalId);
    if (!entry) return false;
    pending.delete(approvalId);
    entry.resolve(approved);
    events.emit({ type: "approval.resolved", sessionId: entry.sessionId, approvalId, approved });
    return true;
  }

  function cancelForSession(sessionId: string): void {
    for (const [id, entry] of pending) {
      if (entry.sessionId !== sessionId) continue;
      pending.delete(id);
      entry.resolve(false);
      events.emit({ type: "approval.resolved", sessionId, approvalId: id, approved: false });
    }
  }

  return { request, resolve, cancelForSession };
}

export type ApprovalManager = ReturnType<typeof createApprovalManager>;
