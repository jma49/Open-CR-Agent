import type { AppliedSettings, Effort, Sampling } from "@open-cr-agent/core";
import type { CallParams } from "./openai.js";

export type EffortStyle = "openai" | "openrouter";

// What each call sends besides the conversation, and what the run applied
// per agent (ADR-0025). Reasoning models refuse a temperature (OpenAI) or
// need their own (Anthropic), so a call that asks for an effort other than
// "none" sends no sampling settings, even after its endpoint refused the
// effort: the agent's calls stay alike within a run.
export class EffortLedger {
  // Models whose endpoint refused the effort parameter: later calls go
  // without it instead of paying for another refusal.
  private readonly refused = new Set<string>();
  private readonly applied = new Map<string, AppliedSettings>();

  private readonly sampling: Sampling;

  constructor(sampling: Sampling) {
    this.sampling = sampling;
  }

  params(
    agent: string,
    effort: Effort | undefined,
    model: string,
    style: EffortStyle = "openai",
  ): CallParams {
    if (effort === undefined) return { ...this.sampling };
    const keepsSampling = effort === "none";
    const sends = !this.refused.has(model);
    this.record(agent, sends, keepsSampling ? [] : requested(this.sampling));
    return {
      ...(keepsSampling ? this.sampling : {}),
      ...(sends ? effortParam(effort, style) : {}),
    };
  }

  refuse(agent: string, model: string): void {
    this.refused.add(model);
    this.record(agent, false, []);
  }

  appliedTo(agent: string): AppliedSettings | undefined {
    const applied = this.applied.get(agent);
    return applied && { ...applied };
  }

  private record(agent: string, sent: boolean, notApplied: (keyof Sampling)[]): void {
    const before = this.applied.get(agent);
    const left = [...new Set([...(before?.notApplied ?? []), ...notApplied])];
    this.applied.set(agent, {
      effort: (before?.effort ?? true) && sent,
      ...(left.length > 0 ? { notApplied: left } : {}),
    });
  }
}

function effortParam(effort: Effort, style: EffortStyle): CallParams {
  return style === "openrouter" ? { reasoning: { effort } } : { reasoning_effort: effort };
}

function requested(sampling: Sampling): (keyof Sampling)[] {
  return (["temperature", "seed"] as const).filter((key) => sampling[key] !== undefined);
}
