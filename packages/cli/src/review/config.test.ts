import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_SCHEMA_ID, ConfigError, configJsonSchema, loadConfig } from "./config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(config?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-config-"));
  dirs.push(dir);
  if (config !== undefined) {
    mkdirSync(join(dir, ".ocra"));
    writeFileSync(join(dir, ".ocra", "config.json"), config);
  }
  return dir;
}

describe("loadConfig", () => {
  it("returns defaults without a config file", async () => {
    expect(await loadConfig(root(), {})).toEqual({
      models: {},
      include: [],
      exclude: [],
      runtime: "opencode",
      plugins: [],
      reviewers: {},
      github: {},
      rules: [],
      pluginSettings: {},
      providers: {},
    });
  });

  it("reads a provider reached through an OpenAI-compatible API", async () => {
    const warnings: string[] = [];
    const dir = root(
      JSON.stringify({
        models: { standard: ["gateway/qwen3-coder"], light: "local/free" },
        providers: {
          gateway: {
            type: "openai-compatible",
            baseUrl: "https://llm.example.com/v1",
            apiKeyEnv: "GATEWAY_API_KEY",
            models: { "qwen3-coder": { input: 0.5, output: 2, cachedInput: 0.1 } },
          },
          local: {
            type: "openai-compatible",
            baseUrl: "http://127.0.0.1:8000/v1",
            models: { free: { input: 0, output: 0 } },
          },
        },
      }),
    );
    const config = await loadConfig(dir, {}, { repository: true, warn: (m) => warnings.push(m) });
    expect(config.providers).toEqual({
      gateway: {
        baseUrl: "https://llm.example.com/v1",
        apiKeyEnv: "GATEWAY_API_KEY",
        models: { "qwen3-coder": { input: 0.5, output: 2, cachedInput: 0.1 } },
      },
      local: { baseUrl: "http://127.0.0.1:8000/v1", models: { free: { input: 0, output: 0 } } },
    });
    expect(warnings).toEqual([
      "local/free has a price of 0: reported cost and --max-cost-usd do not count its tokens",
    ]);
  });

  it.each([
    [{ baseUrl: "http://llm.example.com/v1" }, "must be an https URL"],
    [{ apiKeyEnv: "GITHUB_TOKEN" }, "must not name a platform or cloud credential"],
    [{ apiKeyEnv: "CI_JOB_TOKEN" }, "must not name a platform or cloud credential"],
    [{ apiKeyEnv: "AWS_SECRET_ACCESS_KEY" }, "must not name a platform or cloud credential"],
    [{ apiKeyEnv: "AZURE_API_KEY" }, "must not name a platform or cloud credential"],
    // OpenCode would replace these with a file's content or a variable.
    [{ baseUrl: "https://llm.example.com/v1?d={file:.git/config}" }, "must not contain { or }"],
    [{ baseUrl: "https://llm.example.com/{env:GEMINI_API_KEY}/v1" }, "must not contain { or }"],
    [{ models: {} }, "must list at least one model"],
    [{ models: { m: { input: 1 } } }, "output"],
    [{ type: "anthropic" }, "type"],
  ])("refuses a provider with %j", async (change, message) => {
    const provider = {
      type: "openai-compatible",
      baseUrl: "https://llm.example.com/v1",
      models: { m: { input: 1, output: 2 } },
      ...change,
    };
    const dir = root(JSON.stringify({ providers: { gateway: provider } }));
    await expect(loadConfig(dir, {})).rejects.toThrow(message);
  });

  it("reads the config file and lets environment variables override models", async () => {
    const dir = root(
      JSON.stringify({
        models: { top: "a/top", standard: ["a/std", "a/std-old"] },
        concurrency: 2,
      }),
    );
    const config = await loadConfig(dir, {});
    expect(config).toMatchObject({
      models: { top: ["a/top"], standard: ["a/std", "a/std-old"] },
      concurrency: 2,
    });

    const overridden = await loadConfig(dir, {
      OCRA_MODEL_STANDARD: " b/std , b/old ",
      OCRA_MODEL_LIGHT: "",
    });
    expect(overridden.models).toEqual({ top: ["a/top"], standard: ["b/std", "b/old"] });
  });

  it("ignores the repository's file, and its plugins, when asked to", async () => {
    const dir = root(JSON.stringify({ plugins: ["./evil.mjs"], concurrency: 2 }));
    const config = await loadConfig(dir, { OCRA_MODEL_STANDARD: "a/std" }, { repository: false });
    expect(config.plugins).toEqual([]);
    expect(config.concurrency).toBeUndefined();
    expect(config.models).toEqual({ standard: ["a/std"] });
  });

  it("reads the user's own file instead of the repository's, with --no-repo-config too", async () => {
    const dir = root(JSON.stringify({ concurrency: 2, plugins: ["./evil.mjs"] }));
    const own = join(dir, "..", `ocra-own-${process.pid}.json`);
    writeFileSync(own, JSON.stringify({ concurrency: 7, exclude: ["vendor/**"] }));
    try {
      const config = await loadConfig(dir, {}, { repository: false, file: own });
      expect(config).toMatchObject({ concurrency: 7, exclude: ["vendor/**"], plugins: [] });
      const trusted = await loadConfig(dir, {}, { repository: true, file: own });
      expect(trusted.concurrency).toBe(7);
      writeFileSync(own, "{");
      await expect(loadConfig(dir, {}, { repository: true, file: own })).rejects.toThrow(
        `${own} is not valid JSON`,
      );
      await expect(
        loadConfig(dir, {}, { repository: true, file: join(dir, "missing.json") }),
      ).rejects.toThrow("cannot read");
    } finally {
      rmSync(own, { force: true });
    }
  });

  it("rejects invalid JSON, unknown keys and bad values", async () => {
    await expect(loadConfig(root("{"), {})).rejects.toThrow(ConfigError);
    await expect(loadConfig(root('{"modles":{}}'), {})).rejects.toThrow(
      ".ocra/config.json is invalid",
    );
    await expect(loadConfig(root('{"concurrency":0}'), {})).rejects.toThrow(
      ".ocra/config.json is invalid",
    );
  });
});

describe("configJsonSchema", () => {
  it("is what docs/schema/config.v1.json holds (npm run schema regenerates it)", () => {
    const published = JSON.parse(
      readFileSync(new URL("../../../../docs/schema/config.v1.json", import.meta.url), "utf8"),
    );
    expect(published).toEqual(configJsonSchema());
  });

  it("is a closed draft 2020-12 schema that lists the built-in runtimes", () => {
    const schema = configJsonSchema();
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe(CONFIG_SCHEMA_ID);
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).toContain('"enum":["opencode","direct"]');
  });

  it("lets a file name its schema and a runtime, built-in or registered by a plugin", async () => {
    const schema = "https://example.com/config.v1.json";
    for (const runtime of ["direct", "my-runtime"]) {
      const config = await loadConfig(root(JSON.stringify({ $schema: schema, runtime })), {});
      expect(config.runtime).toBe(runtime);
    }
    await expect(loadConfig(root(JSON.stringify({ runtime: "" })), {})).rejects.toThrow(
      ConfigError,
    );
  });
});
