import { emptyUsage } from "../agent/usage.js";
import type { AgentRuntime } from "../contracts.js";
import { usageSpent } from "../errors.js";
import type { ReviewEvent } from "./report.js";

// The runtime with each plain completion timed and told as a model_called
// event, so every stage's calls reach the trace without each caller
// reporting them. Tasks pass through: their attempts are timed where they
// run (withFailback).
export function tracedRuntime(
  runtime: AgentRuntime,
  emit: (event: ReviewEvent) => void,
  now: () => number = performance.now.bind(performance),
): AgentRuntime {
  const complete = runtime.complete?.bind(runtime);
  const traced: AgentRuntime = {
    get name() {
      return runtime.name;
    },
    ...(runtime.agent ? { agent: runtime.agent } : {}),
    ...(runtime.sampling ? { sampling: runtime.sampling } : {}),
    ...(runtime.toolsets ? { toolsets: true as const } : {}),
    ...(runtime.appliedTo ? { appliedTo: runtime.appliedTo.bind(runtime) } : {}),
    ...(runtime.dispose ? { dispose: runtime.dispose.bind(runtime) } : {}),
    runTask: runtime.runTask.bind(runtime),
  };
  if (!complete) return traced;
  traced.complete = async (request, signal) => {
    const started = now();
    const agent = request.agent ?? request.tier;
    const ms = () => Math.round(now() - started);
    try {
      const result = await complete(request, signal);
      emit({
        type: "model_called",
        agent,
        ...(result.model ? { model: result.model } : {}),
        ms: ms(),
        usage: result.usage,
      });
      return result;
    } catch (error) {
      emit({
        type: "model_called",
        agent,
        ms: ms(),
        usage: usageSpent(error) ?? emptyUsage(),
        failed: true,
      });
      throw error;
    }
  };
  return traced;
}
