import { parseJsonAnswer } from "../agent/json.js";
import { type AgentCallSettings, agentCall } from "../agent/settings.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import { usageSpent } from "../errors.js";
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
  const complete = runtime.complete?.bind(runtime);
  if (!complete) return undefined;
  return {
    async group(prompt) {
      const result = await complete(
        {
          tier: "light",
          ...agentCall("helper", call),
          system: prompt.system,
          user: prompt.user,
          timeoutMs: HELPER_TIMEOUT_MS,
        },
        AbortSignal.any([signal, AbortSignal.timeout(HELPER_TIMEOUT_MS)]),
      ).catch((error: unknown) => {
        const spent = usageSpent(error);
        if (spent) onUsage(spent);
        throw error;
      });
      onUsage(result.usage);
      return parseJsonAnswer(result.text);
    },
  };
}
