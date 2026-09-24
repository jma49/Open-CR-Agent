import type { Usage } from "../contracts.js";

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
}

export function addUsage(total: Usage, next: Usage): Usage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    reasoningTokens: total.reasoningTokens + next.reasoningTokens,
    cachedTokens: total.cachedTokens + next.cachedTokens,
    costUsd: total.costUsd + next.costUsd,
  };
}
