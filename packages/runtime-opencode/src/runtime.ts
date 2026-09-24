import type { AgentEvent, AgentRuntime, AgentTaskSpec, ModelTier } from "@open-cr-agent/core";

export interface OpenCodeRuntimeOptions {
  models: { [Tier in ModelTier]?: string | undefined };
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";

  constructor(readonly options: OpenCodeRuntimeOptions) {}

  // biome-ignore lint/correctness/useYield: implemented in #8 after the runtime spike (#2)
  async *runTask(_spec: AgentTaskSpec, _signal: AbortSignal): AsyncIterable<AgentEvent> {
    throw new Error("OpenCodeRuntime.runTask is not implemented yet");
  }
}
