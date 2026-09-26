import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

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
      pluginSettings: {},
    });
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
