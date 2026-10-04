import type { Effort } from "../contracts.js";

// How a model takes a reasoning effort (ADR-0025): OpenAI's level
// (`reasoningEffort`), a budget of thinking tokens (Anthropic, Gemini 2.5),
// or Gemini 3's level (`thinkingLevel`).
export type EffortParameter = "reasoningEffort" | "thinkingBudget" | "thinkingLevel";

export interface EffortCapability {
  parameter: EffortParameter;
  // The levels the model takes. "none" for a thinking budget means no
  // thinking: the parameter left out (Anthropic) or a budget of 0 (Gemini).
  levels: readonly Effort[];
  // A thinking budget's bounds in tokens; it also stays below the model's
  // output limit.
  budget?: { min: number; max?: number };
}

interface Row extends EffortCapability {
  pattern: RegExp;
}

// What ocra knows of current models, matched on the model id's last path
// segment, so "anthropic/claude-sonnet-4-5" and an OpenRouter
// "openrouter/anthropic/claude-sonnet-4.5" both match. It goes stale as
// models ship: a model it does not know, or a level it says a model does
// not take, is left out of the call with a warning, never refused. The first
// matching row wins, so a family's later versions come first.
const CAPABILITIES: readonly Row[] = [
  {
    pattern: /^gpt-5\.\d/,
    parameter: "reasoningEffort",
    levels: ["none", "low", "medium", "high"],
  },
  {
    pattern: /^gpt-5(?:$|-)/,
    parameter: "reasoningEffort",
    levels: ["minimal", "low", "medium", "high"],
  },
  { pattern: /^o[134](?:$|-)/, parameter: "reasoningEffort", levels: ["low", "medium", "high"] },
  {
    pattern: /^claude-(?:(?:opus|sonnet|haiku)-)?[4-9]/,
    parameter: "thinkingBudget",
    levels: ["none", "minimal", "low", "medium", "high"],
    budget: { min: 1_024 },
  },
  {
    pattern: /^gemini-2\.5-pro/,
    parameter: "thinkingBudget",
    levels: ["minimal", "low", "medium", "high"],
    budget: { min: 128, max: 32_768 },
  },
  {
    pattern: /^gemini-2\.5-flash/,
    parameter: "thinkingBudget",
    levels: ["none", "minimal", "low", "medium", "high"],
    budget: { min: 512, max: 24_576 },
  },
  { pattern: /^gemini-3/, parameter: "thinkingLevel", levels: ["low", "high"] },
];

export function effortCapability(model: string): EffortCapability | undefined {
  const id = (model.split("/").at(-1) ?? model).toLowerCase();
  const row = CAPABILITIES.find((r) => r.pattern.test(id));
  if (!row) return undefined;
  const { pattern: _, ...capability } = row;
  return capability;
}

// Share of the model's output limit each level may spend on thinking.
const BUDGET_SHARE: Readonly<Record<Exclude<Effort, "none">, number>> = {
  minimal: 1 / 32,
  low: 1 / 16,
  medium: 1 / 4,
  high: 1 / 2,
};
// Claude Opus 4's output limit, the smallest among the models the table
// knows: a budget derived from it fits all of them.
export const FALLBACK_OUTPUT_LIMIT = 32_000;

// The thinking budget for a level, derived from the model's output limit
// (the fallback when the catalog gives none); 0 for "none". Undefined when
// no budget within the bounds fits below that limit.
export function thinkingBudget(
  capability: EffortCapability,
  level: Effort,
  outputLimit?: number,
): number | undefined {
  if (level === "none") return 0;
  const limit = outputLimit && outputLimit > 0 ? outputLimit : FALLBACK_OUTPUT_LIMIT;
  const min = capability.budget?.min ?? 0;
  const max = Math.min(capability.budget?.max ?? Number.POSITIVE_INFINITY, limit - 1);
  if (min > max) return undefined;
  return Math.min(max, Math.max(min, Math.floor(limit * BUDGET_SHARE[level])));
}
