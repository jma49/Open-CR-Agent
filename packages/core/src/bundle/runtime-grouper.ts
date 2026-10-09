import { parseJsonAnswer } from "../agent/json.js";
import { oneShot } from "../agent/model-call.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { FileGrouper } from "./grouping.js";

const HELPER_TIMEOUT_MS = 60_000;

// Grouping runs on the runtime's cheapest tier when the runtime supports plain
// completions; otherwise bundling falls back to per-file review.
export function runtimeGrouper(
  runtime: AgentRuntime,
  signal: AbortSignal,
  onUsage: (usage: Usage) => void,
  call?: AgentCallSettings,
): FileGrouper | undefined {
  const ask = oneShot(runtime, onUsage);
  if (!ask) return undefined;
  return {
    async group(prompt) {
      const text = await ask(
        {
          tier: "light",
          agent: "helper",
          call,
          system: prompt.system,
          user: prompt.user,
          timeoutMs: HELPER_TIMEOUT_MS,
        },
        signal,
      );
      return parseJsonAnswer(text);
    },
  };
}
