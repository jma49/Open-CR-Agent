import type { ModelTier } from "../contracts.js";
import type { RiskTier } from "../domain.js";
import type { RuleSet } from "../rules/rule-set.js";

// Where a reviewer is worth its cost; the review matrix applies it per bundle.
export interface ReviewerScope {
  // The lowest change risk tier the reviewer runs at (default: every tier).
  minTier?: RiskTier;
  // A lower tier for bundles where the reviewer matters most: on a bundle
  // with a file whose path has one of these whole words (as triage reads
  // sensitive paths), the reviewer runs from this tier.
  focus?: { words: ReadonlySet<string>; minTier: RiskTier };
  // Globs of files the reviewer never sees, such as documentation.
  ignore?: readonly string[];
  // Runs only when the repository has guidelines (AGENTS.md) to check against.
  requiresGuidelines?: boolean;
  // What one task of the reviewer covers (default "bundle": a task per
  // bundle). "packed": whole bundles that follow each other in run order, up
  // to the bundle size limits, for a reviewer whose findings rarely need
  // more than the bundle they sit in. "change": the reviewer compares the
  // change with something outside it (documentation, guidelines), so bundle
  // boundaries mean nothing to it and it gets the change in as few tasks as
  // its size allows.
  span?: "bundle" | "packed" | "change";
}

export interface ReviewerDefinition {
  id: string;
  category: string;
  modelTier: ModelTier;
  systemPrompt: string;
  scope?: ReviewerScope;
  rules?: RuleSet;
}
