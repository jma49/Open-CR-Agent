import type { ModelTier } from "../contracts.js";

export interface ReviewerDefinition {
  id: string;
  category: string;
  modelTier: ModelTier;
  systemPrompt: string;
}
