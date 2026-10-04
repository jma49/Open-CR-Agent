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

// Calls that used tokens but cost nothing: their model has no price (a
// declared model priced at 0, or one missing from the pricing catalog), so
// reported cost and the spend limit cannot count them.
export function unpricedCalls(usages: readonly Usage[]): number {
  return usages.filter((u) => u.inputTokens + u.outputTokens > 0 && u.costUsd === 0).length;
}
