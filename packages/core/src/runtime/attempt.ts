import type { Usage } from "../contracts.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import type { QuotaError } from "./quota.js";

// What one attempt of a task on one model came to, whatever runtime ran it.
export interface AttemptOutcome {
  findings: unknown[];
  // Model requests the attempt made, one per agent step.
  steps: number;
  // Tool names as the review tools define them, without a runtime's prefix.
  toolCalls: string[];
  text: string;
  // The agent stopped early and was told once to finish.
  resumed?: true;
  usage: Usage;
  error?: AttemptError;
}

export interface AttemptError {
  message: string;
  retryable: boolean;
  quota?: QuotaError;
}

// Which tools an attempt spent its steps on, and whether it finished: a
// review that never called task_done was cut off, usually by the step cap.
export function attemptSummary(model: string, outcome: AttemptOutcome): string {
  const { inputTokens, outputTokens, reasoningTokens, costUsd } = outcome.usage;
  const resumed = outcome.resumed ? ", resumed after stopping early" : "";
  return `${model}: ${outcome.steps} step(s), ${toolSummary(outcome.toolCalls)}${resumed}, ${inputTokens} in / ${outputTokens} out / ${reasoningTokens} reasoning tokens, $${costUsd.toFixed(4)}`;
}

export function toolSummary(toolCalls: readonly string[]): string {
  if (toolCalls.length === 0) return "no tool calls";
  const names = toolCalls;
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const byUse = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const finished = names.includes(REVIEW_TOOLS.taskDone) ? "" : "; no task_done";
  return `${toolCalls.length} tool call(s) (${byUse.map(([n, c]) => `${n} ${c}`).join(", ")}${finished})`;
}
