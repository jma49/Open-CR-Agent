import type { AgentEvent, ModelTier } from "@open-cr-agent/core";
import type { ModelHealth } from "./models.js";
import type { SessionOutcome } from "./session-outcome.js";

export interface FailbackOptions {
  taskId: string;
  tier: ModelTier;
  chain: readonly string[];
  health: ModelHealth;
  signal: AbortSignal;
  attempt(model: string): Promise<SessionOutcome>;
}

// Findings from a failed attempt are still emitted: the pipeline deduplicates
// by fingerprint, so a retry on the next model cannot double-report them.
export async function* withFailback(options: FailbackOptions): AsyncGenerator<AgentEvent> {
  const { taskId, health } = options;
  let lastError = "";
  for (const model of health.order(options.chain)) {
    if (options.signal.aborted) return;
    yield { type: "progress", taskId, message: `reviewing with ${model}` };
    const outcome = await options.attempt(model);
    yield { type: "usage", taskId, ...outcome.usage };
    yield { type: "progress", taskId, message: attemptSummary(model, outcome) };
    for (const finding of outcome.findings) yield { type: "finding", taskId, finding };

    if (!outcome.error) {
      health.recordSuccess(model);
      yield { type: "done", taskId };
      return;
    }
    if (!outcome.error.retryable) {
      yield {
        type: "error",
        taskId,
        error: `${model}: ${outcome.error.message}`,
        retryable: false,
      };
      return;
    }
    health.recordFailure(model);
    lastError = `${model}: ${outcome.error.message}`;
    yield { type: "progress", taskId, message: `${lastError}; trying the next model` };
  }
  yield {
    type: "error",
    taskId,
    error: `every ${options.tier} model failed (${lastError})`,
    retryable: true,
  };
}

function attemptSummary(model: string, outcome: SessionOutcome): string {
  const tools =
    outcome.toolCalls.length === 0 ? "no tool calls" : `${outcome.toolCalls.length} tool call(s)`;
  const { inputTokens, outputTokens, reasoningTokens, costUsd } = outcome.usage;
  return `${model}: ${tools}, ${inputTokens} in / ${outputTokens} out / ${reasoningTokens} reasoning tokens, $${costUsd.toFixed(4)}`;
}
