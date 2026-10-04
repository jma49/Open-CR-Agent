import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EffortRoutes, effortOptions } from "./effort.js";
import { type EffortSetup, setUpEfforts } from "./effort-setup.js";

const gateway = {
  gateway: { baseUrl: "https://llm.example.com/v1", models: { m1: { input: 1, output: 1 } } },
  router: {
    baseUrl: "https://router.example.com/v1",
    effort: "openrouter" as const,
    models: { "claude-sonnet-4-5": { input: 1, output: 1 } },
  },
};

describe("effortOptions", () => {
  it("sends OpenAI's reasoningEffort, and only the levels the model takes", () => {
    expect(effortOptions("openai/gpt-5", "minimal")).toEqual({ reasoningEffort: "minimal" });
    expect(effortOptions("openai/gpt-5.5", "none")).toEqual({ reasoningEffort: "none" });
    expect(effortOptions("openai/o3", "minimal")).toBeUndefined();
    expect(effortOptions("openai/gpt-4o", "high")).toBeUndefined();
  });

  it("gives Claude a thinking budget below the output limit, and none for none", () => {
    expect(effortOptions("anthropic/claude-sonnet-4-5", "high", {}, 64_000)).toEqual({
      thinking: { type: "enabled", budgetTokens: 32_000 },
    });
    expect(effortOptions("anthropic/claude-sonnet-4-5", "low")).toEqual({
      thinking: { type: "enabled", budgetTokens: 2_000 },
    });
    expect(effortOptions("anthropic/claude-sonnet-4-5", "none")).toEqual({});
  });

  it("gives Gemini 2.5 a thinking budget and Gemini 3 a thinking level", () => {
    expect(effortOptions("google/gemini-2.5-pro", "medium", {}, 65_536)).toEqual({
      thinkingConfig: { thinkingBudget: 16_384 },
    });
    expect(effortOptions("google-vertex/gemini-2.5-flash", "none")).toEqual({
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    });
    expect(effortOptions("google/gemini-3.1-pro-preview", "high")).toEqual({
      thinkingConfig: { thinkingLevel: "high" },
    });
    expect(effortOptions("google/gemini-3.1-pro-preview", "medium")).toBeUndefined();
  });

  it("sends a declared provider's style for any model the table does not rule out", () => {
    expect(effortOptions("gateway/m1", "low", gateway)).toEqual({ reasoningEffort: "low" });
    expect(effortOptions("router/claude-sonnet-4-5", "high", gateway)).toEqual({
      reasoning: { effort: "high" },
    });
    expect(effortOptions("openrouter/openai/gpt-5", "low")).toEqual({
      reasoning: { effort: "low" },
    });
  });

  it("sends nothing through a catalog provider it has no mapping for", () => {
    expect(effortOptions("azure/gpt-5", "low")).toBeUndefined();
    expect(effortOptions("groq/llama-3.3-70b", "low")).toBeUndefined();
  });
});

describe("EffortRoutes", () => {
  const models = [
    "openai/gpt-5",
    "anthropic/claude-sonnet-4-5",
    "google/gemini-2.5-pro",
    "google/gemini-3.1-pro-preview",
    "groq/llama-3.3-70b",
  ];
  const known = new Map([
    ["openai/gpt-5", 128_000],
    ["anthropic/claude-sonnet-4-5", 64_000],
    ["google/gemini-2.5-pro", 65_536],
    ["google/gemini-3.1-pro-preview", 0],
    ["groq/llama-3.3-70b", 8_192],
  ]);

  it("declares one variant per model and level that sends something", () => {
    const config = new EffortRoutes(models, {}, known).providerConfig();
    expect(config.openai?.models["gpt-5"]?.variants).toEqual({
      "ocra-minimal": { reasoningEffort: "minimal" },
      "ocra-low": { reasoningEffort: "low" },
      "ocra-medium": { reasoningEffort: "medium" },
      "ocra-high": { reasoningEffort: "high" },
    });
    expect(Object.keys(config.anthropic?.models["claude-sonnet-4-5"]?.variants ?? {})).toEqual([
      "ocra-minimal",
      "ocra-low",
      "ocra-medium",
      "ocra-high",
    ]);
    expect(config.anthropic?.models["claude-sonnet-4-5"]?.variants["ocra-high"]).toEqual({
      thinking: { type: "enabled", budgetTokens: 32_000 },
    });
    expect(config.google?.models["gemini-2.5-pro"]?.variants["ocra-high"]).toEqual({
      thinkingConfig: { thinkingBudget: 32_768 },
    });
    expect(config.google?.models["gemini-3.1-pro-preview"]?.variants).toEqual({
      "ocra-low": { thinkingConfig: { thinkingLevel: "low" } },
      "ocra-high": { thinkingConfig: { thinkingLevel: "high" } },
    });
    expect(config).not.toHaveProperty("groq");
  });

  it("routes two levels on one model to different variants, and none on Claude to none", () => {
    const routes = new EffortRoutes(models, {}, known);
    expect(routes.route("anthropic/claude-sonnet-4-5", "high")).toEqual({ variant: "ocra-high" });
    expect(routes.route("anthropic/claude-sonnet-4-5", "low")).toEqual({ variant: "ocra-low" });
    expect(routes.route("anthropic/claude-sonnet-4-5", "none")).toEqual({});
    expect(routes.route("openai/gpt-5", "none")).toBeUndefined();
    expect(routes.route("groq/llama-3.3-70b", "high")).toBeUndefined();
  });

  it("declares nothing for a model the catalog does not know", () => {
    const routes = new EffortRoutes(["openai/gpt-9"], {}, new Map());
    expect(routes.empty).toBe(true);
    expect(routes.providerConfig()).toEqual({});
  });

  it("keeps only the variants OpenCode loaded", () => {
    const routes = new EffortRoutes(models, {}, known);
    routes.keepLoaded(new Map([["openai/gpt-5", new Set(["ocra-low", "high"])]]));
    expect(routes.route("openai/gpt-5", "low")).toEqual({ variant: "ocra-low" });
    expect(routes.route("openai/gpt-5", "high")).toBeUndefined();
    expect(routes.route("anthropic/claude-sonnet-4-5", "high")).toBeUndefined();
    expect(routes.route("anthropic/claude-sonnet-4-5", "none")).toEqual({});
  });
});

// OpenCode's answer to GET /config/providers, as far as the setup reads it.
function catalog(models: Record<string, { output: number; variants?: string[] }>) {
  const providers = new Map<string, Record<string, unknown>>();
  for (const [model, entry] of Object.entries(models)) {
    const [provider = "", ...id] = model.split("/");
    const byId = providers.get(provider) ?? {};
    byId[id.join("/")] = {
      limit: { context: 1, output: entry.output },
      variants: Object.fromEntries((entry.variants ?? []).map((v) => [v, {}])),
    };
    providers.set(provider, byId);
  }
  return {
    providers: async () => ({
      data: { providers: [...providers].map(([id, byId]) => ({ id, models: byId })) },
    }),
  } as unknown as EffortSetup["probe"];
}

describe("setUpEfforts", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const file = () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-effort-"));
    dirs.push(dir);
    return join(dir, "opencode.json");
  };

  it("writes variants with budgets from the catalog's output limits, for known models only", async () => {
    const path = file();
    const routes = await setUpEfforts({
      models: ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-9-9"],
      probe: catalog({ "anthropic/claude-sonnet-4-5": { output: 64_000 } }),
      workspace: catalog({
        "anthropic/claude-sonnet-4-5": { output: 64_000, variants: ["ocra-high", "high"] },
      }),
      file: path,
    });
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(Object.keys(written.provider.anthropic.models)).toEqual(["claude-sonnet-4-5"]);
    expect(written.provider.anthropic.models["claude-sonnet-4-5"].variants["ocra-high"]).toEqual({
      thinking: { type: "enabled", budgetTokens: 32_000 },
    });
    expect(routes.route("anthropic/claude-sonnet-4-5", "high")).toEqual({ variant: "ocra-high" });
    expect(routes.route("anthropic/claude-sonnet-4-5", "low")).toBeUndefined();
    expect(routes.route("anthropic/claude-sonnet-9-9", "high")).toBeUndefined();
  });

  it("asks OpenCode nothing when no model can take an effort", async () => {
    const unused = {
      providers: async () => {
        throw new Error("called");
      },
    } as unknown as EffortSetup["probe"];
    const routes = await setUpEfforts({
      models: ["groq/llama-3.3-70b"],
      probe: unused,
      workspace: unused,
      file: file(),
    });
    expect(routes.empty).toBe(true);
  });

  it("sends no effort, without failing, when the catalog cannot be read", async () => {
    const failing = {
      providers: async () => {
        throw new Error("down");
      },
    } as unknown as EffortSetup["probe"];
    const routes = await setUpEfforts({
      models: ["openai/gpt-5"],
      probe: failing,
      workspace: failing,
      file: file(),
    });
    expect(routes.route("openai/gpt-5", "low")).toBeUndefined();
  });
});
