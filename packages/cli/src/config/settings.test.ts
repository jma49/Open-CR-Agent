import { describe, expect, it } from "vitest";
import { layerSchema, listSettings, resolveSettings } from "./settings.js";

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

describe("listSettings", () => {
  it("lists --plan's settings in order with their sources, defaults without a value", () => {
    const { settings, sources } = resolveSettings([
      {
        source: "shared",
        settings: { rules: [{ path: "**", rule: "Long text.", source: "shared" }] },
      },
      { source: "env", settings: { models: { top: ["a/t"] } } },
      { source: "account", under: true, settings: { reviewers: { docs: { enabled: false } } } },
    ]);
    const listed = listSettings(settings, sources);
    expect(listed.map((s) => s.key)).toEqual([
      "runtime",
      "models.top",
      "models.standard",
      "models.light",
      "effort.top",
      "effort.standard",
      "effort.light",
      "reviewers.docs",
      "concurrency",
      "taskTimeoutMinutes",
      "runTimeoutMinutes",
      "maxCostUsd",
      "maxTasks",
      "verify",
      "judge",
      "sampling",
      "include",
      "exclude",
      "rules",
    ]);
    expect(listed).toContainEqual({ key: "models.top", value: ["a/t"], sources: ["env"] });
    expect(listed).toContainEqual({ key: "runtime", sources: [] });
    expect(listed).toContainEqual({
      key: "rules",
      value: [{ path: "**", source: "shared" }],
      sources: ["shared"],
    });
  });

  it("lists the value the merge applied for every setting, with the layers it came from", () => {
    const { settings, sources } = resolveSettings([
      {
        source: "shared",
        settings: { maxCostUsd: 3, effort: { light: "low" }, exclude: ["v/**"] },
      },
      { source: "file", settings: { maxCostUsd: 1, include: ["src/**"], roles: { judge: {} } } },
      { source: "env", settings: { models: { top: ["a/t"] }, effort: { top: "high" } } },
      {
        source: "account",
        under: true,
        settings: { maxCostUsd: 9, concurrency: 2, exclude: ["d/**"], runtime: "direct" },
      },
    ]);
    for (const { key, value, sources: from } of listSettings(settings, sources)) {
      const [name = "", entry] = key.split(".");
      const applied = (settings as unknown as Record<string, unknown>)[name];
      const expected =
        name === "rules"
          ? settings.rules.map(({ path, source }) => ({ path, source }))
          : entry === undefined
            ? applied
            : (applied as Record<string, unknown>)[entry];
      expect(from).toEqual(sources[key] ?? []);
      if (from.length > 0) expect(value).toEqual(expected);
    }
  });

  it("lists ultra when the account turned it on, not when only the flag did", () => {
    const account = { source: "account", under: true, settings: { ultra: true } } as const;
    const flag = { source: "flag", settings: { ultra: true } } as const;
    const ultra = (layers: Parameters<typeof resolveSettings>[0]) => {
      const { settings, sources } = resolveSettings(layers);
      return { on: settings.ultra, listed: listSettings(settings, sources).at(-1) };
    };
    expect(ultra([account])).toEqual({
      on: true,
      listed: { key: "ultra", value: true, sources: ["account"] },
    });
    expect(ultra([account, flag]).on).toBe(true);
    expect(ultra([account, flag]).listed?.key).toBe("rules");
    expect(ultra([]).on).toBe(false);
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
