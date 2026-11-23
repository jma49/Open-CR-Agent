import { oneShot } from "../agent/model-call.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import { errorMessage } from "../errors.js";
import type { ReviewPrompt } from "./prompt.js";
import type { ReviewerDefinition } from "./reviewer.js";

const PLAN_TIMEOUT_MS = 60_000;
const MAX_PLAN_CHARS = 1_500;

// What a plan call's prompt ends with, where a review's ends with the order
// to review.
export const PLAN_INSTRUCTIONS =
  "Do not review yet, and call no tool in this answer. List at most five specific things to check in <ocra_review_files>, most important first. Each item names the file and the function or lines, and says what to verify and why it could go wrong. Do not report findings, do not restate the task, and do not add general advice. Answer with a plain bullet list of at most 150 words.";

// The plan phase: one short call that turns the bundle into a checklist for
// the reviewer, so its steps go to the riskiest code first. It is asked as
// the reviewer, in the words its review then opens with, so a runtime that
// stores prompts lets the review read them (ADR-0066). A failed plan costs
// the checklist, not the review.
export async function planBundle(
  runtime: AgentRuntime,
  reviewer: ReviewerDefinition,
  prompt: ReviewPrompt,
  signal: AbortSignal,
  call?: AgentCallSettings,
): Promise<{ plan?: string; usage: Usage[]; warning?: string }> {
  const usage: Usage[] = [];
  const ask = oneShot(runtime, (u) => usage.push(u));
  if (!ask) return { usage };
  try {
    const answer = await ask(
      {
        tier: reviewer.modelTier,
        agent: reviewer.id,
        call,
        system: prompt.system,
        user: prompt.user,
        sharedPrefixes: prompt.shared,
        timeoutMs: PLAN_TIMEOUT_MS,
      },
      signal,
    );
    // Model output is data: the review prompt embeds it through data().
    const plan = answer.trim().slice(0, MAX_PLAN_CHARS);
    return plan ? { plan, usage } : { usage };
  } catch (error) {
    return {
      usage,
      warning: `plan phase for ${reviewer.id} failed, reviewing without a plan: ${errorMessage(error)}`,
    };
  }
}
