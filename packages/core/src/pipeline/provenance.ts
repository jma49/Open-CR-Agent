import { createHash } from "node:crypto";
import type { ResolvedAgent, ReviewerOverrides } from "../agent/settings.js";
import { RELOCATE_SYSTEM_PROMPT } from "../anchor/relocate.js";
import { GROUPING_SYSTEM_PROMPT } from "../bundle/grouping.js";
import type { AgentRuntime, AppliedSampling, Sampling } from "../contracts.js";
import { JUDGE_SYSTEM_PROMPT } from "../judge/prompt.js";
import type { AgentProvenance, RuleProvenance, RunProvenance } from "../report/provenance.js";
import { PLAN_SYSTEM_PROMPT } from "../review/plan-phase.js";
import { buildReviewPrompt } from "../review/prompt.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { SourcedRule } from "../rules/repo-rules.js";
import { VERIFY_SYSTEM_PROMPT } from "../verify/prompt.js";

// Supplied by the caller; the review adds the prompt hash and what the
// runtime applied.
export interface ProvenanceInput {
  ocraVersion: string;
  configHash: string;
  // What was asked for; a runtime that does not say what it applied is
  // reported as applying none of it.
  sampling?: Sampling;
  accountSettings?: { version: string | null };
}

// A short digest of a JSON value, the same whatever order its keys were
// written in.
export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, 16);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// The system prompts this configuration sends: each enabled reviewer's, as
// the review task gets it, and every helper stage's. Only instructions are
// hashed, never the change under review, so runs over different changes
// with the same build and reviewers share the hash.
export function promptHash(
  reviewers: readonly ReviewerDefinition[],
  overrides: ReviewerOverrides = {},
): string {
  const reviewerPrompts = reviewers
    .filter((r) => overrides[r.id]?.enabled !== false)
    .map((r) => [r.id, reviewerSystemPrompt(r)])
    .sort(([a], [b]) => ((a as string) < (b as string) ? -1 : 1));
  return stableHash({
    reviewers: Object.fromEntries(reviewerPrompts),
    helpers: {
      grouping: GROUPING_SYSTEM_PROMPT,
      plan: PLAN_SYSTEM_PROMPT,
      relocate: RELOCATE_SYSTEM_PROMPT,
      verify: VERIFY_SYSTEM_PROMPT,
      judge: JUDGE_SYSTEM_PROMPT,
    },
  });
}

function reviewerSystemPrompt(reviewer: ReviewerDefinition): string {
  return buildReviewPrompt({
    reviewer,
    changeRequest: { id: "", title: "", description: "", baseSha: "", headSha: "" },
    changedFiles: [],
    bundle: [],
    rules: "",
  }).system;
}

export function appliedSampling(
  runtime: { readonly sampling?: AppliedSampling },
  requested: Sampling = {},
): AppliedSampling {
  if (runtime.sampling) return runtime.sampling;
  const asked = (Object.keys(requested) as (keyof Sampling)[]).filter(
    (key) => requested[key] !== undefined,
  );
  return asked.length > 0 ? { notApplied: asked } : {};
}

// A runtime that cannot say what it applied applied no effort.
export function agentProvenance(
  agents: readonly ResolvedAgent[],
  runtime: Pick<AgentRuntime, "appliedTo">,
): Record<string, AgentProvenance> {
  const entries = agents.map(({ id, tier, effort, models }): [string, AgentProvenance] => {
    const base = { tier, ...(models ? { models: [...models] } : {}) };
    if (effort === undefined) return [id, base];
    if (!runtime.appliedTo) return [id, { ...base, effort, applied: false }];
    const applied = runtime.appliedTo(id);
    if (!applied) return [id, { ...base, effort }];
    return [
      id,
      {
        ...base,
        effort,
        applied: applied.effort,
        ...(applied.notApplied?.length ? { notApplied: [...applied.notApplied] } : {}),
      },
    ];
  });
  return Object.fromEntries(entries);
}

export function runProvenance(
  input: ProvenanceInput,
  runtime: Pick<AgentRuntime, "sampling" | "appliedTo">,
  reviewers: readonly ReviewerDefinition[],
  agents: readonly ResolvedAgent[],
  overrides?: ReviewerOverrides,
  rules: readonly SourcedRule[] = [],
): RunProvenance {
  return {
    ocraVersion: input.ocraVersion,
    promptHash: promptHash(reviewers, overrides),
    configHash: input.configHash,
    sampling: appliedSampling(runtime, input.sampling),
    agents: agentProvenance(agents, runtime),
    ...(rules.length > 0 ? { rules: rules.map(ruleProvenance) } : {}),
    ...(input.accountSettings
      ? { accountSettings: { version: input.accountSettings.version } }
      : {}),
  };
}

function ruleProvenance({ path, rule, source }: SourcedRule): RuleProvenance {
  return {
    path: typeof path === "string" ? [path] : [...path],
    rule,
    ...(source ? { source } : {}),
  };
}
