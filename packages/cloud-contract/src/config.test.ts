import { describe, expect, it } from "vitest";
import { configSchema } from "./config.js";

// What the JSON Schema cannot say, and ocra Cloud must refuse as a review does.
describe("the configuration schema", () => {
  it.each([
    ["a plain http endpoint elsewhere", { providers: { p: provider("http://models.example") } }],
    ["an endpoint with braces", { providers: { p: provider("https://x.example/{env:HOME}") } }],
    ["a platform credential", { providers: { p: { ...provider(), apiKeyEnv: "GITHUB_TOKEN" } } }],
    ["a provider without models", { providers: { p: { ...provider(), models: {} } } }],
    ["two checks with one id", { mergeChecks: [check("a"), check("a")] }],
  ])("refuses %s", (_, config) => {
    expect(configSchema.safeParse(config).success).toBe(false);
  });

  it.each([
    [
      "a provider address",
      { providers: { p: provider("not a url") } },
      ["providers", "p", "baseUrl"],
    ],
    [
      "a tracker address",
      { trackers: { jira: { ...jira(), server: { url: "jira.example/mcp" } } } },
      ["trackers", "jira", "server", "url"],
    ],
  ])("reports %s that is not a URL as one issue on its path", (_, config, path) => {
    let result: ReturnType<typeof configSchema.safeParse> | undefined;
    expect(() => {
      result = configSchema.safeParse(config);
    }).not.toThrow();
    expect(result?.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [path, "Invalid URL"],
    ]);
  });

  it("takes an https endpoint, http on this machine, and distinct checks", () => {
    for (const config of [
      { providers: { p: provider() } },
      { providers: { p: provider("http://127.0.0.1:8080/v1") } },
      { providers: { p: provider("http://[::1]:8080/v1") } },
      { mergeChecks: [check("a"), check("b")] },
    ]) {
      expect(configSchema.safeParse(config).success, JSON.stringify(config)).toBe(true);
    }
  });
});

function provider(baseUrl = "https://models.example/v1") {
  return {
    type: "openai-compatible",
    baseUrl,
    apiKeyEnv: "MODELS_KEY",
    models: { m: { input: 1, output: 2 } },
  };
}

function jira() {
  return {
    projects: ["OCRA"],
    server: { url: "https://jira.example/mcp" },
    tool: "get",
    keyArgument: "key",
  };
}

function check(id: string) {
  return { id, instruction: "Say why." };
}
