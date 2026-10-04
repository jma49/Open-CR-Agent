import { describe, expect, it } from "vitest";
import { effortCapability, FALLBACK_OUTPUT_LIMIT, thinkingBudget } from "./effort-capability.js";

describe("effortCapability", () => {
  it("maps OpenAI reasoning models to reasoningEffort and their levels", () => {
    expect(effortCapability("openai/gpt-5")).toEqual({
      parameter: "reasoningEffort",
      levels: ["minimal", "low", "medium", "high"],
    });
    expect(effortCapability("openai/gpt-5-mini")?.levels).toContain("minimal");
    expect(effortCapability("openai/gpt-5.5")?.levels).toEqual(["none", "low", "medium", "high"]);
    expect(effortCapability("openai/o3")?.levels).toEqual(["low", "medium", "high"]);
    expect(effortCapability("openai/gpt-4o")).toBeUndefined();
  });

  it("maps Claude 4 and later to a thinking budget of at least 1,024 tokens", () => {
    for (const model of [
      "anthropic/claude-sonnet-4-5",
      "anthropic/claude-opus-4-1-20250805",
      "anthropic/claude-sonnet-5-5",
      "openrouter/anthropic/claude-haiku-4.5",
    ]) {
      expect(effortCapability(model)).toMatchObject({
        parameter: "thinkingBudget",
        budget: { min: 1_024 },
      });
    }
    expect(effortCapability("anthropic/claude-3-5-sonnet")).toBeUndefined();
  });

  it("maps Gemini 2.5 to a thinking budget and Gemini 3 to a thinking level", () => {
    expect(effortCapability("google/gemini-2.5-pro")).toMatchObject({
      parameter: "thinkingBudget",
      levels: ["minimal", "low", "medium", "high"],
    });
    expect(effortCapability("google-vertex/gemini-2.5-flash")?.levels).toContain("none");
    expect(effortCapability("google/gemini-3.1-pro-preview")).toEqual({
      parameter: "thinkingLevel",
      levels: ["low", "high"],
    });
  });

  it("knows nothing of other models", () => {
    expect(effortCapability("groq/llama-3.3-70b")).toBeUndefined();
    expect(effortCapability("local/m1")).toBeUndefined();
  });
});

describe("thinkingBudget", () => {
  const claude = effortCapability("anthropic/claude-sonnet-4-5");
  const flash = effortCapability("google/gemini-2.5-flash");

  it("derives each level's budget from the output limit, below it", () => {
    if (!claude) throw new Error("no capability");
    expect(thinkingBudget(claude, "minimal", 64_000)).toBe(2_000);
    expect(thinkingBudget(claude, "low", 64_000)).toBe(4_000);
    expect(thinkingBudget(claude, "medium", 64_000)).toBe(16_000);
    expect(thinkingBudget(claude, "high", 64_000)).toBe(32_000);
    expect(thinkingBudget(claude, "high", 1_500)).toBe(1_024);
    expect(thinkingBudget(claude, "none", 64_000)).toBe(0);
  });

  it("keeps the model's bounds, and falls back to a fixed limit without one", () => {
    if (!claude || !flash) throw new Error("no capability");
    expect(thinkingBudget(claude, "minimal", 16_000)).toBe(1_024);
    expect(thinkingBudget(flash, "high", 65_536)).toBe(24_576);
    expect(thinkingBudget(claude, "high")).toBe(FALLBACK_OUTPUT_LIMIT / 2);
    expect(thinkingBudget(claude, "high", 0)).toBe(FALLBACK_OUTPUT_LIMIT / 2);
    expect(thinkingBudget(claude, "low", 1_000)).toBeUndefined();
  });
});
