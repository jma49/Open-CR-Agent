import type { AgentRuntime, Effort, ModelChains, ModelTier } from "../contracts.js";
import type { RiskTier } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";

export const EFFORT_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
] as const satisfies readonly Effort[];

// The agents that are not reviewers (ADR-0025). Helpers group files and
// relocate quotes, nothing else; the verifier and the judge never inherit
// a reviewer's settings, so checking stays independent of what was checked.
export type AgentRole = "verifier" | "judge" | "helper";
export const AGENT_ROLES: readonly AgentRole[] = ["verifier", "judge", "helper"];
export const ROLE_TIERS: Readonly<Record<AgentRole, ModelTier>> = {
  verifier: "standard",
  judge: "top",
  helper: "light",
};

export interface ReviewerOverride {
  enabled?: boolean | undefined;
  minTier?: RiskTier | undefined;
  // Both cover the reviewer's review tasks and its plan call; models is its
  // own failback chain, absent: its tier's.
  effort?: Effort | undefined;
  models?: readonly string[] | undefined;
}

export type ReviewerOverrides = Readonly<Record<string, ReviewerOverride>>;

export type TierEfforts = { readonly [Tier in ModelTier]?: Effort | undefined };

export interface RoleSetting {
  effort?: Effort | undefined;
  // The role's own failback chain; absent: its tier's.
  models?: readonly string[] | undefined;
}

export type RoleSettings = { readonly [Role in AgentRole]?: RoleSetting | undefined };

// The per-agent settings of a review: an agent's own, else its tier's.
export interface AgentSettings {
  effort?: TierEfforts | undefined;
  // The tier chains the runtime was given, so an agent's resolved chain can
  // be recorded; calls never carry them.
  models?: ModelChains | undefined;
  roles?: RoleSettings | undefined;
  reviewerOverrides?: ReviewerOverrides | undefined;
}

export interface ResolvedAgent {
  id: string;
  tier: ModelTier;
  effort?: Effort;
  // Its own chain, else its tier's when known.
  models?: readonly string[];
}

// What an agent's calls carry besides the prompt: its effort, and its own
// chain when it has one (absent: the runtime uses the tier's).
export interface AgentCallSettings {
  effort?: Effort;
  models?: readonly string[];
}

// A reviewer's effort covers every call made on its behalf: its review
// tasks and its plan call.
export function reviewerEffort(
  reviewer: Pick<ReviewerDefinition, "id" | "modelTier">,
  settings: AgentSettings,
): Effort | undefined {
  return settings.reviewerOverrides?.[reviewer.id]?.effort ?? settings.effort?.[reviewer.modelTier];
}

export function roleEffort(role: AgentRole, settings: AgentSettings): Effort | undefined {
  return settings.roles?.[role]?.effort ?? settings.effort?.[ROLE_TIERS[role]];
}

// Like its effort, a reviewer's own chain covers its review tasks and its
// plan call; the roles have their own and never take a reviewer's.
export function reviewerCall(
  reviewer: Pick<ReviewerDefinition, "id" | "modelTier">,
  settings: AgentSettings,
): AgentCallSettings {
  return callSettings(
    reviewerEffort(reviewer, settings),
    settings.reviewerOverrides?.[reviewer.id]?.models,
  );
}

export function roleCall(role: AgentRole, settings: AgentSettings): AgentCallSettings {
  return callSettings(roleEffort(role, settings), settings.roles?.[role]?.models);
}

function callSettings(
  effort: Effort | undefined,
  models: readonly string[] | undefined,
): AgentCallSettings {
  return {
    ...(effort === undefined ? {} : { effort }),
    ...(models?.length ? { models: [...models] } : {}),
  };
}

// The enabled reviewers and the roles, each with its tier and effort.
export function resolveAgents(
  reviewers: readonly ReviewerDefinition[],
  settings: AgentSettings,
): ResolvedAgent[] {
  const agent = (id: string, tier: ModelTier, call: AgentCallSettings): ResolvedAgent => {
    const models = call.models ?? settings.models?.[tier];
    return {
      id,
      tier,
      ...(call.effort === undefined ? {} : { effort: call.effort }),
      ...(models?.length ? { models: [...models] } : {}),
    };
  };
  return [
    ...reviewers
      .filter((r) => settings.reviewerOverrides?.[r.id]?.enabled !== false)
      .map((r) => agent(r.id, r.modelTier, reviewerCall(r, settings))),
    ...AGENT_ROLES.map((role) => agent(role, ROLE_TIERS[role], roleCall(role, settings))),
  ];
}

// The request fields that name an agent, its effort and its own chain.
export function agentCall(
  agent: string,
  call: AgentCallSettings = {},
): { agent: string } & AgentCallSettings {
  return { agent, ...call };
}

// Said once per run, so a configured effort that never reached a model is
// not mistaken for one that did.
export function effortWarnings(
  agents: readonly ResolvedAgent[],
  runtime: Pick<AgentRuntime, "name" | "appliedTo">,
): string[] {
  const asked = agents.filter((a) => a.effort !== undefined);
  if (asked.length === 0) return [];
  const { appliedTo } = runtime;
  if (!appliedTo) {
    return [
      `the ${runtime.name} runtime does not apply reasoning effort; the effort configured for ${asked.map((a) => a.id).join(", ")} was not sent`,
    ];
  }
  const applied = asked.map((a) => ({ agent: a, settings: appliedTo.call(runtime, a.id) }));
  const unsupported = applied.flatMap(({ agent, settings }) =>
    settings?.unsupported?.length
      ? [
          `the ${runtime.name} runtime did not send reasoning effort "${agent.effort}" for ${agent.id} to ${settings.unsupported.join(", ")}: ocra's capability table knows no way to send that level to that model`,
        ]
      : [],
  );
  const refused = applied
    .filter(({ settings }) => settings?.effort === false && !settings.unsupported?.length)
    .map(({ agent }) => agent.id);
  return refused.length === 0
    ? unsupported
    : [
        ...unsupported,
        `the endpoint refused the reasoning effort for ${refused.join(", ")}; those calls were sent again without it`,
      ];
}
