import type { AgentRuntime, Effort, ModelTier } from "../contracts.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { ReviewerOverrides } from "./matrix.js";

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

export type TierEfforts = { readonly [Tier in ModelTier]?: Effort | undefined };

export interface RoleSetting {
  effort?: Effort | undefined;
}

export type RoleSettings = { readonly [Role in AgentRole]?: RoleSetting | undefined };

// The per-agent settings of a review: an agent's own, else its tier's.
export interface AgentSettings {
  effort?: TierEfforts | undefined;
  roles?: RoleSettings | undefined;
  reviewerOverrides?: ReviewerOverrides | undefined;
}

export interface ResolvedAgent {
  id: string;
  tier: ModelTier;
  effort?: Effort;
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

// The enabled reviewers and the roles, each with its tier and effort.
export function resolveAgents(
  reviewers: readonly ReviewerDefinition[],
  settings: AgentSettings,
): ResolvedAgent[] {
  const agent = (id: string, tier: ModelTier, effort: Effort | undefined): ResolvedAgent =>
    effort === undefined ? { id, tier } : { id, tier, effort };
  return [
    ...reviewers
      .filter((r) => settings.reviewerOverrides?.[r.id]?.enabled !== false)
      .map((r) => agent(r.id, r.modelTier, reviewerEffort(r, settings))),
    ...AGENT_ROLES.map((role) => agent(role, ROLE_TIERS[role], roleEffort(role, settings))),
  ];
}

// The request fields that name an agent and its effort.
export function agentCall(
  agent: string,
  effort: Effort | undefined,
): { agent: string; effort?: Effort } {
  return effort === undefined ? { agent } : { agent, effort };
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
      `the ${runtime.name} runtime does not apply reasoning effort yet; the effort configured for ${asked.map((a) => a.id).join(", ")} was not sent`,
    ];
  }
  const refused = asked.filter((a) => appliedTo.call(runtime, a.id)?.effort === false);
  return refused.length === 0
    ? []
    : [
        `the endpoint refused the reasoning effort for ${refused.map((a) => a.id).join(", ")}; those calls were sent again without it`,
      ];
}
