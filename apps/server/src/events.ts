import type { ServerEvent } from "@codestate/shared";

type Listener = (event: ServerEvent) => Promise<void> | void;

export class EventBus {
  private listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener) {
    const listeners = this.listeners.get(sessionId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  emit(event: ServerEvent) {
    const listeners = this.listeners.get(event.sessionId);
    if (!listeners) return;
    for (const listener of listeners) void listener(event);
  }
}
