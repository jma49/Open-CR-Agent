import { type AgentEvent, type ModelTier, REVIEW_TOOLS } from "@open-cr-agent/core";
import type { ModelHealth } from "./models.js";
import { sleep } from "./quota.js";
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
  const { taskId, health, signal } = options;
  let lastError = "";
  for (const model of health.order(options.chain)) {
    for (;;) {
      if (signal.aborted) return;
      const pause = health.pausedFor(model);
      if (pause > 0) {
        yield {
          type: "progress",
          taskId,
          message: `${model} is rate limited; waiting ${Math.ceil(pause / 1000)}s`,
        };
        await sleep(pause, signal);
        if (signal.aborted) return;
      }
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
      if (outcome.error.quota && health.recordQuota(model, outcome.error.quota) === "wait") {
        continue;
      }
      if (!outcome.error.quota) health.recordFailure(model);
      lastError = `${model}: ${outcome.error.message}`;
      yield { type: "progress", taskId, message: `${lastError}; trying the next model` };
      break;
    }
  }
  yield {
    type: "error",
    taskId,
    error: lastError
      ? `every ${options.tier} model failed (${lastError})`
      : `every ${options.tier} model is out of quota for this run`,
    retryable: true,
  };
}

// Which tools an attempt spent its steps on, and whether it finished: a
// review that never called task_done was cut off, usually by the step cap.
function attemptSummary(model: string, outcome: SessionOutcome): string {
  const { inputTokens, outputTokens, reasoningTokens, costUsd } = outcome.usage;
  return `${model}: ${outcome.steps} step(s), ${toolSummary(outcome.toolCalls)}, ${inputTokens} in / ${outputTokens} out / ${reasoningTokens} reasoning tokens, $${costUsd.toFixed(4)}`;
}

export function toolSummary(toolCalls: readonly string[]): string {
  if (toolCalls.length === 0) return "no tool calls";
  // MCP tools carry the server's name as a prefix (MCP_SERVER in runtime.ts).
  const names = toolCalls.map((t) => t.replace(/^ocra_/, ""));
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const byUse = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const finished = names.includes(REVIEW_TOOLS.taskDone) ? "" : "; no task_done";
  return `${toolCalls.length} tool call(s) (${byUse.map(([n, c]) => `${n} ${c}`).join(", ")}${finished})`;
}
