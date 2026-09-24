import type { FileGrouper } from "../bundle/grouping.js";
import type { AgentRuntime, Usage } from "../contracts.js";

export const HELPER_TIMEOUT_MS = 60_000;

// Grouping runs on the runtime's cheapest tier when the runtime supports plain
// completions; otherwise bundling falls back to per-file review.
export function runtimeGrouper(
  runtime: AgentRuntime,
  signal: AbortSignal,
  onUsage: (usage: Usage) => void,
): FileGrouper | undefined {
  const complete = runtime.complete?.bind(runtime);
  if (!complete) return undefined;
  return {
    async group(prompt) {
      const result = await complete(
        { tier: "light", system: prompt.system, user: prompt.user, timeoutMs: HELPER_TIMEOUT_MS },
        AbortSignal.any([signal, AbortSignal.timeout(HELPER_TIMEOUT_MS)]),
      );
      onUsage(result.usage);
      return parseJsonAnswer(result.text);
    },
  };
}

// Models often wrap JSON in a Markdown fence or add a sentence around it.
export function parseJsonAnswer(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error("the model answered without JSON");
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  return JSON.parse(candidate.slice(start, end + 1));
}
