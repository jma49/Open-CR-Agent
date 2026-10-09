import type { AgentRuntime, ModelTier, Usage } from "../contracts.js";
import { usageSpent } from "../errors.js";
import { type AgentCallSettings, agentCall } from "./settings.js";

// One plain completion outside the review tasks: grouping, relocation, a
// plan phase, Verify, Judge.
interface OneShotRequest {
  tier: ModelTier;
  // A reviewer id (its plan call), or the role "verifier", "judge" or "helper".
  agent: string;
  call?: AgentCallSettings | undefined;
  system: string;
  user: string;
  timeoutMs: number;
}

// Answers with the model's text, or throws what the call threw.
export type OneShot = (request: OneShotRequest, signal: AbortSignal) => Promise<string>;

// Undefined when the runtime makes no plain completions; each caller decides
// what it does without one. A call's timeout goes both in the request and
// on its signal, so a runtime that ignores one is still stopped by the
// other, and what it spent is reported through onUsage whether it answered
// or failed: no call goes uncounted in the report and the spend limit.
export function oneShot(
  runtime: AgentRuntime,
  onUsage: (usage: Usage) => void,
): OneShot | undefined {
  const complete = runtime.complete?.bind(runtime);
  if (!complete) return undefined;
  return async ({ tier, agent, call, system, user, timeoutMs }, signal) => {
    const answer = await complete(
      { tier, ...agentCall(agent, call), system, user, timeoutMs },
      AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    ).catch((error: unknown) => {
      const spent = usageSpent(error);
      if (spent) onUsage(spent);
      throw error;
    });
    onUsage(answer.usage);
    return answer.text;
  };
}
