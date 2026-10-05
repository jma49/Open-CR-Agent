import type { IncompleteEnding, Usage } from "../contracts.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import type { QuotaError } from "./quota.js";

// Each step resends the whole conversation, so an unbounded loop is the
// largest cost risk. At 20 steps a quarter of the review tasks on Vertex
// ended at the cap and one golden bug was never found; at 30 it was found in
// both runs, for about a third more cost on average (2026-09-28). Most tasks
// finish in about 15 steps and never reach it.
export const MAX_AGENT_STEPS = 30;

// About one review attempt in twelve on Gemini ended after a step or two
// with no text, no done tool and steps to spare (2026-09-28), and the task
// counted as completed with its files unread. Sent once to such an agent, in
// the same conversation, which keeps what it read and is cheaper than
// starting over.
export const RESUME_MESSAGE = `You stopped before finishing the review. Continue with the files in <ocra_review_files> you have not reviewed yet, report each confirmed issue with ${REVIEW_TOOLS.reportFinding}, and call ${REVIEW_TOOLS.taskDone} when every file is done.`;

// Text with every secret replaced: a provider's error may echo the request's
// headers, and a progress line or session file must not carry the key.
export function withoutSecrets(text: string, secrets: readonly string[]): string {
  return secrets.reduce((shown, secret) => shown.replaceAll(secret, "<key>"), text);
}

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
  // Its last turn used every step it was allowed without the done tool. Only
  // the runtime knows: OpenCode caps each turn, so a resumed session's steps
  // add up past the cap without either turn reaching it.
  atStepCap?: true;
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

// How an attempt ended. Read before any later turn of the attempt (the
// wrap-up turn of #470) can call the done tool, so that turn cannot make a
// cut-off review count as finished.
export type AttemptEnding = "done" | IncompleteEnding | "error";

export function attemptEnding(outcome: AttemptOutcome): AttemptEnding {
  if (outcome.error) return "error";
  if (outcome.toolCalls.includes(REVIEW_TOOLS.taskDone)) return "done";
  return outcome.atStepCap ? "step_cap" : "stopped_early";
}
