import { describe, expect, it } from "vitest";
import { type CliConfig, loadConfig } from "../config/cli-config.js";
import { type AccountSettings, parseAccountSettings } from "./account-settings.js";
import { layerAccountSettings } from "./settings.js";

async function config(file?: object): Promise<CliConfig> {
  return loadConfig(
    "/repo",
    {},
    {
      repository: true,
      read: async () => (file ? JSON.stringify(file) : undefined),
    },
  );
}

function account(body: unknown): AccountSettings {
  const { settings, warnings } = parseAccountSettings(body);
  expect(warnings).toEqual([]);
  return settings;
}

const agents = account({
  runtime: "direct",
  models: { standard: ["ocra-openrouter/a"], top: ["ocra-openrouter/t"] },
  agents: {
    effort: { standard: "low", top: "high" },
    reviewers: {
      security: { effort: "high", models: ["ocra-openrouter/s"] },
      docs: { enabled: false },
    },
    roles: { judge: { effort: "high" } },
  },
  version: "v7",
});

describe("account settings under the repository's configuration", () => {
  it("fill only the agents the configuration leaves out", async () => {
    const repo = await config({
      runtime: "opencode",
      models: { standard: "google/gemini-3.5-flash" },
      effort: { standard: "medium" },
      reviewers: { security: { enabled: false } },
    });
    const { config: out, filled } = layerAccountSettings(repo, agents);
    expect(out.models.standard).toEqual(["google/gemini-3.5-flash"]);
    expect(out.models.top).toEqual(["ocra-openrouter/t"]);
    expect(out.effort).toEqual({ standard: "medium", top: "high" });
    // The repository's whole entry for a reviewer wins.
    expect(out.reviewers.security).toEqual({ enabled: false });
    expect(out.reviewers.docs).toEqual({ enabled: false });
    expect(out.roles.judge).toEqual({ effort: "high" });
    expect(out.runtime).toBe("opencode");
    expect(filled).toEqual(["models.top", "effort.top", "reviewers.docs", "roles.judge"]);
    expect(out.accountSettings).toEqual({ version: "v7" });
  });

  it("set the runtime only when the configuration does not", async () => {
    const { config: out, filled } = layerAccountSettings(await config(), agents);
    expect(out.runtime).toBe("direct");
    expect(filled).toContain("runtime");
    expect(filled).toContain("models.standard");
  });

  it("fill each limit the configuration leaves unset, and never loosen one it set", async () => {
    const limits = account({
      settings: {
        concurrency: 2,
        maxCostUsd: 5,
        maxTasks: 10,
        verify: false,
        judge: false,
        taskTimeoutMinutes: 3,
        runTimeoutMinutes: 30,
        sampling: { temperature: 0.2 },
      },
    });
    const repo = await config({ maxCostUsd: 1, verify: true, sampling: { seed: 4 } });
    const { config: out, filled } = layerAccountSettings(repo, limits);
    expect(out.maxCostUsd).toBe(1);
    expect(out.verify).toBe(true);
    // A scalar wins whole: the account's temperature does not join the file's seed.
    expect(out.sampling).toEqual({ seed: 4 });
    expect(out).toMatchObject({
      concurrency: 2,
      maxTasks: 10,
      judge: false,
      taskTimeoutMinutes: 3,
      runTimeoutMinutes: 30,
    });
    expect(filled).toEqual([
      "concurrency",
      "taskTimeoutMinutes",
      "runTimeoutMinutes",
      "maxTasks",
      "judge",
    ]);
  });

  it("combine include, exclude and rules, the repository's first", async () => {
    const extra = account({
      settings: {
        include: ["docs/**", "src/**"],
        exclude: ["**/*.snap"],
        rules: [{ path: "src/**", rule: "Account rule." }],
      },
    });
    const repo = await config({ include: ["src/**"] });
    const { config: out, filled } = layerAccountSettings(repo, extra);
    expect(out.include).toEqual(["src/**", "docs/**"]);
    expect(out.exclude).toEqual(["**/*.snap"]);
    expect(out.rules).toEqual([{ path: "src/**", rule: "Account rule.", source: "account" }]);
    expect(filled).toEqual(["include", "exclude", "rules"]);
  });

  it("add nothing to include when the account repeats the repository's", async () => {
    const same = account({ settings: { include: ["src/**"] } });
    const { config: out, filled } = layerAccountSettings(
      await config({ include: ["src/**"] }),
      same,
    );
    expect(out.include).toEqual(["src/**"]);
    expect(filled).toEqual([]);
  });
});
