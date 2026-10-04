import { describe, expect, it } from "vitest";
import preferences from "../fixtures/preferences.json" with { type: "json" };
import {
  agentPrefsSchema,
  modelChainsSchema,
  preferencesUpdateSchema,
  reviewSettingsSchema,
} from "./preferences.js";

const { runtime, models, agents, settings } = preferences.answer;
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("the preferences a client saves", () => {
  it("keep every part of the fixture", () => {
    expect(preferencesUpdateSchema.parse({ runtime, models, agents, settings })).toEqual({
      runtime,
      models,
      agents,
      settings,
    });
  });

  it("leave out the parts the body leaves out, and keep null to clear one", () => {
    expect(preferencesUpdateSchema.parse({ settings: null })).toEqual({ settings: null });
    expect(preferencesUpdateSchema.parse({})).toEqual({});
  });

  it("refuse a runtime that is not built in", () => {
    expect(ok(preferencesUpdateSchema, { runtime: "my-plugin" })).toBe(false);
  });
});

describe("model chains", () => {
  it("take one model on its own, drop empty names and set nothing for an empty chain", () => {
    expect(
      modelChainsSchema.parse({ top: "ocra-openai/gpt-5", standard: ["", "ocra-x/y"], light: [] }),
    ).toEqual({ top: ["ocra-openai/gpt-5"], standard: ["ocra-x/y"] });
  });

  it("refuse more than four models, or one that is not ocra-<provider>/<model>", () => {
    expect(ok(modelChainsSchema, { top: Array(5).fill("ocra-openai/gpt-5") })).toBe(false);
    expect(ok(modelChainsSchema, { top: ["openai/gpt-5"] })).toBe(false);
    expect(ok(modelChainsSchema, { top: ["ocra-Open/gpt-5"] })).toBe(false);
    expect(ok(modelChainsSchema, { top: [5] })).toBe(false);
  });
});

describe("per-agent settings", () => {
  it("read an empty effort as none set, and drop entries that set nothing", () => {
    expect(
      agentPrefsSchema.parse({
        effort: { top: "", standard: null, light: "low" },
        reviewers: { security: {}, logic: null, style: { enabled: false, effort: "" } },
        roles: { judge: { models: [] } },
      }),
    ).toEqual({ effort: { light: "low" }, reviewers: { style: { enabled: false } } });
  });

  it("refuse an unknown effort, a role named as a reviewer, an unknown role and more than 30 reviewers", () => {
    expect(ok(agentPrefsSchema, { effort: { top: "max" } })).toBe(false);
    expect(ok(agentPrefsSchema, { reviewers: { judge: { enabled: true } } })).toBe(false);
    expect(ok(agentPrefsSchema, { reviewers: { "bad id": {} } })).toBe(false);
    expect(ok(agentPrefsSchema, { reviewers: { x: { enabled: null } } })).toBe(false);
    expect(ok(agentPrefsSchema, { roles: { planner: {} } })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`r${i}`, {}]));
    expect(ok(agentPrefsSchema, { reviewers: many })).toBe(false);
  });
});

describe("review settings", () => {
  it("drop what sets nothing, trim rules and list each plugin once", () => {
    expect(
      reviewSettingsSchema.parse({
        concurrency: null,
        include: [],
        sampling: {},
        rules: [{ path: "src/**", rule: "  Keep it.  " }],
        plugins: ["a", "a"],
        pluginSettings: {},
      }),
    ).toEqual({ rules: [{ path: "src/**", rule: "Keep it." }], plugins: ["a"] });
  });

  it("refuse a key they do not know, and values out of the configuration's bounds", () => {
    for (const bad of [
      { providers: {} },
      { concurrency: 0 },
      { concurrency: 1.5 },
      { taskTimeoutMinutes: 0 },
      { runTimeoutMinutes: 601 },
      { maxCostUsd: 1001 },
      { maxTasks: 1001 },
      { verify: "yes" },
      { sampling: { temperature: 3 } },
      { sampling: { topP: 1 } },
      { include: ["a\nb"] },
      { exclude: Array(101).fill("x") },
      { rules: [{ path: [], rule: "r" }] },
      { rules: [{ path: "x", rule: "   " }] },
      { rules: [{ path: "x", rule: "r", severity: "high" }] },
      { plugins: ["Not A Package"] },
      { pluginSettings: { a: {} } },
      { plugins: ["a"], pluginSettings: { a: { blob: "x".repeat(16_384) } } },
    ]) {
      expect(ok(reviewSettingsSchema, bad), JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it("name the plugin whose settings it refuses", () => {
    const result = reviewSettingsSchema.safeParse({ plugins: ["a"], pluginSettings: { b: {} } });
    expect(result.error?.issues.map((i) => i.path)).toEqual([["pluginSettings", "b"]]);
  });
});

describe("the parsed types", () => {
  it("name each part's keys, so a server can read them", () => {
    const agents = agentPrefsSchema.parse({ reviewers: { security: { effort: "high" } } });
    const effort: string | undefined = agents.reviewers?.security?.effort;
    const models: string[] | undefined = agents.roles?.judge?.models;
    expect([effort, models]).toEqual(["high", undefined]);
  });
});
