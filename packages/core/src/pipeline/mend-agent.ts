import type { SpendLimit } from "../agent/spend-limit.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type { CallFailure } from "../errors.js";
import { type AgentItem, type AgentTaskDeps, agentTask } from "../mend/agent-lane.js";
import type { ItemPatch } from "../mend/patch.js";
import { executeTask } from "./task.js";

type AgentRejection = "failed" | "declined" | "no_room";

type AgentAttempt =
  | { patch: ItemPatch; heads: ReadonlyMap<string, string> }
  | { reason: AgentRejection; cause?: CallFailure; warning?: string };

interface AgentLaneDeps extends AgentTaskDeps {
  runtime: AgentRuntime;
  spendLimit: Pick<SpendLimit, "mayCall" | "charge">;
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

// One item through the agent lane's task. Its edits are taken only when the
// agent ended with the done tool: a task that failed, timed out, ran out of
// steps or was stopped at the spend limit leaves none.
export async function agentPatch(item: AgentItem, deps: AgentLaneDeps): Promise<AgentAttempt> {
  if (!deps.spendLimit.mayCall()) return { reason: "no_room" };
  const { spec, workspace } = agentTask(item, deps);
  const overSpent = new AbortController();
  const result = await executeTask(
    deps.runtime,
    spec,
    AbortSignal.any([deps.signal, overSpent.signal]),
    {
      onProgress: () => {},
      onUsage: (usage) => {
        deps.spendLimit.charge(usage);
        deps.onUsage(usage);
        if (!deps.spendLimit.mayCall()) overSpent.abort();
      },
      category: "",
    },
  );
  deps.signal.throwIfAborted();
  if (result.status !== "completed") {
    if (overSpent.signal.aborted) return { reason: "no_room" };
    return {
      reason: "failed",
      cause: result.status === "timed_out" ? "timeout" : "unknown",
      warning: `the fix task for ${item.id} ${result.status}: ${result.error ?? "no reason given"}`,
    };
  }
  if (result.ended) return { reason: "failed" };
  const { hunks, heads } = workspace.patch();
  return hunks.length === 0 ? { reason: "declined" } : { patch: { item: item.id, hunks }, heads };
}
