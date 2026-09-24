import type { AgentEvent, AgentRuntime, AgentTaskSpec } from "@open-cr-agent/core";

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";

  // biome-ignore lint/correctness/useYield: implemented in M1
  async *runTask(_spec: AgentTaskSpec, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    throw new Error("OpenCodeRuntime.runTask is not implemented yet");
  }
}
