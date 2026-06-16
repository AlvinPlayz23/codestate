import { createApprovalManager } from "./approvals.js";
import { runTurn } from "./loop.js";
import type { AgentOptions } from "./types.js";

/**
 * Owns per-session runtime state (abort controllers, pending approvals) and
 * exposes the three entry points the server calls: `run`, `abort`, and
 * `resolveApproval`. The actual turn logic lives in `loop.ts`.
 */
export function createAgent(options: AgentOptions) {
  const approvals = createApprovalManager(options.events);
  const abortControllers = new Map<string, AbortController>();

  async function run(sessionId: string, userMessage: string, yolo = false, displayMessage = userMessage) {
    const controller = new AbortController();
    abortControllers.set(sessionId, controller);

    try {
      await runTurn({ ...options, approvals }, sessionId, userMessage, yolo, controller.signal, displayMessage);
    } catch (error) {
      // Safety net for failures before the turn loop's own handling (e.g. the
      // store rejecting). The loop persists and reports everything else itself.
      options.events.emit({
        type: "session.error",
        sessionId,
        message: error instanceof Error ? error.message : String(error)
      });
    } finally {
      // Only clear the entry if it is still ours; a newer run may have replaced it.
      if (abortControllers.get(sessionId) === controller) abortControllers.delete(sessionId);
    }
  }

  function abort(sessionId: string) {
    abortControllers.get(sessionId)?.abort();
    abortControllers.delete(sessionId);
    approvals.cancelForSession(sessionId);
  }

  function resolveApproval(approvalId: string, approved: boolean) {
    return approvals.resolve(approvalId, approved);
  }

  return { run, abort, resolveApproval };
}

export type { AgentOptions } from "./types.js";
