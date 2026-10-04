import { describe, expect, it } from "vitest";
import { parseAccountSettings } from "./account-settings.js";

describe("parseAccountSettings", () => {
  it("refuses an invalid key alone, naming it, and keeps the rest", () => {
    const { settings, warnings } = parseAccountSettings({
      agents: { effort: { standard: "max" }, roles: { judge: { effort: "high" } } },
      settings: { concurrency: 0, maxTasks: 5 },
      version: "v1",
    });
    expect(settings).toEqual({ version: "v1", roles: { judge: { effort: "high" } }, maxTasks: 5 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/agents\.effort .*settings\.concurrency/);
  });

  it("refuses what a configuration could not hold", () => {
    const cases: [unknown, string][] = [
      [{ agents: { reviewers: { security: { plugins: ["x"] } } } }, "agents.reviewers"],
      [{ models: { standard: [""] } }, "models"],
      [{ settings: { sampling: { temperature: 5 } } }, "settings.sampling"],
      [{ settings: { include: "src/**" } }, "settings.include"],
      [{ settings: { rules: [{ path: "**", rule: "x".repeat(2_001) }] } }, "settings.rules"],
      [{ settings: { rules: Array(51).fill({ path: "**", rule: "r" }) } }, "settings.rules"],
      [{ settings: { rules: [{ path: "**", rule: "r", extra: 1 }] } }, "settings.rules"],
    ];
    for (const [body, key] of cases) {
      const { settings, warnings } = parseAccountSettings(body);
      expect(settings).toEqual({ version: null });
      expect(warnings.join("\n")).toContain(key);
    }
  });

  it("refuses an account model that does not go through ocra Cloud", () => {
    for (const body of [
      { models: { top: ["openai/gpt-5"] } },
      { agents: { reviewers: { security: { models: ["openai/gpt-5"] } } } },
      { agents: { roles: { judge: { models: "local/m" } } } },
    ]) {
      const { settings, warnings } = parseAccountSettings(body);
      expect(settings).toEqual({ version: null });
      expect(warnings[0]).toContain("ocra-<provider>/<model>");
    }
  });

  it("never takes providers, extends or github from the account", () => {
    const { settings, warnings } = parseAccountSettings({
      providers: { evil: { baseUrl: "https://evil.example" } },
      settings: {
        providers: { evil: {} },
        extends: "https://evil.example/c.json",
        github: { botLogin: "attacker" },
        botLogin: "attacker",
        maxTasks: 3,
      },
    });
    expect(settings).toEqual({ version: null, maxTasks: 3 });
    expect(warnings).toEqual([
      "ignoring providers, settings.providers, settings.extends, settings.github, settings.botLogin from ocra Cloud: only a configuration file may set them",
    ]);
  });

  it("ignores unknown keys with one warning naming them, and empty ones silently", () => {
    const { settings, warnings } = parseAccountSettings({
      theme: "dark",
      agents: { tone: "kind" },
      settings: { futureKey: 1, plugins: [], pluginSettings: {}, verify: null, judge: false },
      updatedAt: "2026-10-04T00:00:00Z",
      version: null,
    });
    expect(settings).toEqual({ version: null, judge: false });
    expect(warnings).toEqual([
      "ignoring ocra Cloud settings this version of ocra does not know: theme, agents.tone, settings.futureKey",
    ]);
  });

  it("leaves out a runtime that is not built in", () => {
    const { settings, warnings } = parseAccountSettings({ runtime: "./evil.js" });
    expect(settings.runtime).toBeUndefined();
    expect(warnings[0]).toContain("runtime");
    expect(parseAccountSettings({ runtime: null })).toEqual({
      settings: { version: null },
      warnings: [],
    });
  });

  it("reads a body that is not an object as no settings", () => {
    expect(parseAccountSettings([1, 2])).toEqual({ settings: { version: null }, warnings: [] });
    expect(parseAccountSettings("x").settings).toEqual({ version: null });
  });
});
