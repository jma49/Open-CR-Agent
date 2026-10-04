import type { AppliedSampling, Effort, ModelTier, Sampling } from "../contracts.js";
import type { RuleSource } from "../rules/repo-rules.js";

// What a run was made with, so two runs can be told apart before their
// numbers are compared: the ocra build, the instructions the models were
// given, the configuration and the sampling settings.
export interface RunProvenance {
  ocraVersion: string;
  promptHash: string;
  // The caller's hash of its effective configuration, secrets left out.
  configHash: string;
  sampling: AppliedSampling;
  // Per agent (each enabled reviewer, and the verifier, judge and helper
  // roles): its model tier, the effort it asked for, and what was applied.
  // Absent from reports made before agents were recorded.
  agents?: Record<string, AgentProvenance>;
  // The path rules the review was given, each with where it came from when
  // the caller said. Absent when there were none.
  rules?: RuleProvenance[];
  // The version of the ocra Cloud account settings layered under the
  // configuration (ADR-0027); null when the account has never saved any.
  // Absent when none were applied.
  accountSettings?: { version: string | null };
}

export interface RuleProvenance {
  path: string[];
  rule: string;
  source?: RuleSource;
}

export interface AgentProvenance {
  tier: ModelTier;
  // The failback chain its calls used: its own, else its tier's. Absent when
  // the review was not told the tier chains.
  models?: string[];
  effort?: Effort;
  // With an effort: whether every call sent it. Absent when the agent made
  // no call that asked for one.
  applied?: boolean;
  // Sampling settings the agent's calls left out because they sent an effort.
  notApplied?: (keyof Sampling)[];
}
