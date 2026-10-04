import { z } from "zod";

// The words both sides use. The engine's core declares the same values for
// its own domain (core depends on nothing); the cli's tests check the two
// agree, so a new verdict or tier cannot reach one side only.

export const VERDICTS = [
  "approved",
  "approved_with_comments",
  "minor_issues",
  "significant_concerns",
] as const;
export const verdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof verdictSchema>;

/** The review's risk tier, as a report records it. */
export const RISK_TIERS = ["trivial", "lite", "full"] as const;
export const riskTierSchema = z.enum(RISK_TIERS);
export type RiskTier = z.infer<typeof riskTierSchema>;

export const SEVERITIES = ["critical", "warning", "suggestion"] as const;
export const severitySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof severitySchema>;

export const VERIFICATIONS = ["confirmed", "uncertain", "unchecked"] as const;
export const verificationSchema = z.enum(VERIFICATIONS);
export type Verification = z.infer<typeof verificationSchema>;

/** Where a review ran. */
export const REVIEW_SOURCES = ["local", "github", "gitlab"] as const;
export const reviewSourceSchema = z.enum(REVIEW_SOURCES);
export type ReviewSource = z.infer<typeof reviewSourceSchema>;

/** The model tiers, strongest first (ADR-0025). */
export const MODEL_TIERS = ["top", "standard", "light"] as const;
export const modelTierSchema = z.enum(MODEL_TIERS);
export type ModelTier = z.infer<typeof modelTierSchema>;

/** The agents that are not reviewers (ADR-0025). */
export const AGENT_ROLES = ["verifier", "judge", "helper"] as const;
export const agentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof agentRoleSchema>;

/** How much a model reasons before it answers (ADR-0025). */
export const EFFORTS = ["none", "minimal", "low", "medium", "high"] as const;
export const effortSchema = z.enum(EFFORTS);
export type Effort = z.infer<typeof effortSchema>;

/** The built-in runtimes an account may name; a plugin runtime would load code. */
export const RUNTIMES = ["direct", "opencode"] as const;
export const runtimeSchema = z.enum(RUNTIMES);
export type Runtime = z.infer<typeof runtimeSchema>;

/**
 * A reviewer id as the engine makes them: built-in ids, SARIF tool slugs
 * (which may start with a digit) and plugin reviewers. Bounded, and without
 * spaces or punctuation that could mean something else.
 */
export const REVIEWER_ID = /^[A-Za-z0-9][\w.:@-]{0,99}$/;
/** A repository as the CLI uploads it: a salted SHA-256, never its name (ADR-0028). */
export const REPO_HASH = /^[0-9a-f]{64}$/;
