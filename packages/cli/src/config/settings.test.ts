import { describe, expect, it } from "vitest";
import { layerSchema, resolveSettings } from "./settings.js";

describe("resolveSettings", () => {
  it("applies ocra's defaults and records no source for them", () => {
    const { settings, sources } = resolveSettings([]);
    expect(settings).toMatchObject({ include: [], models: {}, reviewers: {}, rules: [] });
    expect(sources).toEqual({});
  });

  it("replaces whole values and map entries, and records the layer that set each", () => {
    const { settings, sources } = resolveSettings([
      { source: "shared", settings: { maxTasks: 5, maxCostUsd: 2, models: { top: ["a/t"] } } },
      { source: "file", settings: { maxTasks: 2, models: { light: ["b/l"] } } },
      { source: "env", settings: { models: { top: ["c/t"] } } },
    ]);
    expect(settings).toMatchObject({
      maxTasks: 2,
      maxCostUsd: 2,
      models: { top: ["c/t"], light: ["b/l"] },
    });
    expect(sources).toEqual({
      maxTasks: ["file"],
      maxCostUsd: ["shared"],
      "models.top": ["env"],
      "models.light": ["file"],
    });
  });

  it("concatenates lists in layer order and records every layer that added", () => {
    const { settings, sources } = resolveSettings([
      { source: "shared", settings: { exclude: ["vendor/**"] } },
      { source: "file", settings: { exclude: ["vendor/**", "gen/**"], include: [] } },
    ]);
    expect(settings.exclude).toEqual(["vendor/**", "vendor/**", "gen/**"]);
    expect(sources).toEqual({ exclude: ["shared", "file"] });
  });

  it("lets a layer under the others fill only what they left unset", () => {
    const { settings, sources } = resolveSettings([
      { source: "file", settings: { maxTasks: 2, exclude: ["a/**"], reviewers: { docs: {} } } },
      {
        source: "account",
        under: true,
        settings: {
          maxTasks: 7,
          concurrency: 3,
          runtime: "direct",
          exclude: ["a/**", "b/**"],
          reviewers: { docs: { enabled: false }, security: { effort: "high" } },
        },
      },
    ]);
    expect(settings).toMatchObject({
      maxTasks: 2,
      concurrency: 3,
      runtime: "direct",
      exclude: ["a/**", "b/**"],
      reviewers: { docs: {}, security: { effort: "high" } },
    });
    expect(sources).toEqual({
      maxTasks: ["file"],
      concurrency: ["account"],
      runtime: ["account"],
      exclude: ["file", "account"],
      "reviewers.docs": ["file"],
      "reviewers.security": ["account"],
    });
  });

  it("refuses a setting its layer may not set", () => {
    expect(() =>
      resolveSettings([{ source: "account", settings: { extends: "https://x.test/c.json" } }]),
    ).toThrow("the account settings may not set extends");
    expect(() => resolveSettings([{ source: "shared", settings: { plugins: ["p"] } }])).toThrow(
      "the shared settings may not set plugins",
    );
  });
});

describe("layerSchema", () => {
  it("holds only what a layer sets, checked like the configuration file", () => {
    expect(layerSchema.parse({ maxTasks: 2 })).toEqual({ maxTasks: 2 });
    expect(layerSchema.parse({ models: { top: "a/t" } })).toEqual({ models: { top: ["a/t"] } });
    expect(layerSchema.safeParse({ modles: {} }).success).toBe(false);
    expect(layerSchema.safeParse({ concurrency: 0 }).success).toBe(false);
  });
});
