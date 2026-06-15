import type { EventBus } from "../events.js";
import type { JsonSessionStore } from "../sessions/store.js";
import type { CodestateTools } from "../tools/tools.js";

export type AgentOptions = {
  projectRoot: string;
  model: string;
  events: EventBus;
  tools: CodestateTools;
  store: JsonSessionStore;
};
