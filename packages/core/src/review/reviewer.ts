import type { ModelTier } from "../contracts.js";
import type { RiskTier } from "../domain.js";

// Where a reviewer is worth its cost; the review matrix applies it per bundle.
export interface ReviewerScope {
  // The lowest change risk tier the reviewer runs at (default: every tier).
  minTier?: RiskTier;
  // Globs of files the reviewer never sees, such as documentation.
  ignore?: readonly string[];
}

export interface ReviewerDefinition {
  id: string;
  category: string;
  modelTier: ModelTier;
  systemPrompt: string;
  scope?: ReviewerScope;
}
