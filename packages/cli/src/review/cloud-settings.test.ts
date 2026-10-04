import { describe, expect, it } from "vitest";
import { layerAccountSettings } from "./cloud-settings.js";
import { type CliConfig, loadConfig, parseAccountSettings } from "./config.js";

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

const account = parseAccountSettings({
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
});

describe("account settings under the repository's configuration", () => {
  it("fill only what the configuration leaves out", async () => {
    if (!account) throw new Error("account settings did not parse");
    const repo = await config({
      runtime: "opencode",
      models: { standard: "google/gemini-3.5-flash" },
      effort: { standard: "medium" },
      reviewers: { security: { enabled: false } },
    });
    const { config: out, filled } = layerAccountSettings(repo, account);
    expect(out.models.standard).toEqual(["google/gemini-3.5-flash"]);
    expect(out.models.top).toEqual(["ocra-openrouter/t"]);
    expect(out.effort).toEqual({ standard: "medium", top: "high" });
    // The repository's whole entry for a reviewer wins.
    expect(out.reviewers.security).toEqual({ enabled: false });
    expect(out.reviewers.docs).toEqual({ enabled: false });
    expect(out.roles.judge).toEqual({ effort: "high" });
    expect(out.runtime).toBe("opencode");
    expect(filled).toEqual(["models.top", "effort.top", "reviewers.docs", "roles.judge"]);
  });

  it("set the runtime only when the configuration does not", async () => {
    if (!account) throw new Error("account settings did not parse");
    const { config: out, filled } = layerAccountSettings(await config(), account);
    expect(out.runtime).toBe("direct");
    expect(filled).toContain("runtime");
    expect(filled).toContain("models.standard");
  });

  it("are refused whole when the server sends what a configuration could not hold", () => {
    expect(parseAccountSettings({ agents: { effort: { standard: "max" } } })).toBeUndefined();
    expect(
      parseAccountSettings({ agents: { reviewers: { security: { plugins: ["x"] } } } }),
    ).toBeUndefined();
    expect(parseAccountSettings({ models: { standard: [""] } })).toBeUndefined();
    // An unknown runtime from the server is left out, not run.
    expect(parseAccountSettings({ runtime: "./evil.js" })?.runtime).toBeUndefined();
    expect(parseAccountSettings({})).toEqual(
      expect.objectContaining({ models: {}, reviewers: {}, roles: {} }),
    );
  });
});
