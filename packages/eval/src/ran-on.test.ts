import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  catalogEntries,
  catalogFile,
  configSnapshotPath,
  modelsOf,
  opencodeInstall,
  ranOnFor,
  runSetup,
} from "./ran-on.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-ran-on-"));
  dirs.push(dir);
  return dir;
}

function write(path: string, content: unknown): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

// A CLI installed with its runtime and opencode-ai, as npm lays them out.
function cliRoot(opencode = "1.18.32"): string {
  const root = temp();
  write(join(root, "package.json"), { name: "@open-cr-agent/cli", version: "0.7.0" });
  const modules = join(root, "node_modules");
  write(join(modules, "@open-cr-agent", "runtime-opencode", "package.json"), {
    name: "@open-cr-agent/runtime-opencode",
    version: "0.7.0",
  });
  write(join(modules, "opencode-ai", "package.json"), { name: "opencode-ai", version: opencode });
  return root;
}

const build = { version: "0.7.0", commit: "c".repeat(40), dirty: false, maxAgentSteps: 30 };

describe("runSetup", () => {
  it("copies the --config file under its hash, without anything secret", async () => {
    const runDir = temp();
    const key = `sk-ant-${"x".repeat(40)}`;
    const text = JSON.stringify(
      {
        models: { standard: "anthropic/claude-haiku-5-5" },
        providers: {
          mine: {
            type: "openai-compatible",
            baseUrl: "https://example.com/v1",
            apiKeyEnv: "MINE_API_KEY",
            apiKey: "hunter2-not-allowed",
            models: { m: { input: 1, output: 2 } },
          },
        },
        note: key,
      },
      null,
      2,
    );
    const file = write(join(temp(), "eval.json"), text);
    const setup = await runSetup(build, runDir, file, {}, cliRoot());
    const sha256 = createHash("sha256").update(text).digest("hex");
    expect(setup).toEqual({
      ocra: build,
      runtime: "opencode",
      opencode: { version: "1.18.32" },
      config: { file, sha256, runtime: "opencode" },
    });
    const copy = readFileSync(join(runDir, configSnapshotPath(sha256)), "utf8");
    expect(copy).toContain('"apiKeyEnv": "MINE_API_KEY"');
    expect(copy).toContain('"standard": "anthropic/claude-haiku-5-5"');
    expect(copy).not.toContain("hunter2-not-allowed");
    expect(copy).not.toContain(key);
  });

  it("knows the runtime the file names, and none a shared configuration may", async () => {
    const config = async (settings: unknown) =>
      runSetup(build, temp(), write(join(temp(), "c.json"), settings), {}, cliRoot());
    const direct = await config({ runtime: "direct" });
    expect(direct.runtime).toBe("direct");
    expect(direct).not.toHaveProperty("opencode");
    const shared = await config({ extends: "https://example.com/ocra.json" });
    expect(shared).not.toHaveProperty("runtime");
    expect(shared.opencode).toEqual({ version: "1.18.32" });
  });

  it("runs on OpenCode by default, from the install or the binary set", async () => {
    expect(await runSetup(build, temp(), undefined, {}, cliRoot("1.2.3"))).toEqual({
      ocra: build,
      runtime: "opencode",
      opencode: { version: "1.2.3" },
    });
    expect(opencodeInstall(temp(), { OCRA_OPENCODE_BIN: "/opt/opencode" })).toEqual({
      bin: "/opt/opencode",
    });
    expect(opencodeInstall(temp(), {})).toBeUndefined();
  });
});

describe("catalogEntries", () => {
  const catalog = {
    anthropic: {
      models: {
        "claude-haiku-5-5": {
          name: "Claude Haiku 5.5",
          description: "left out",
          cost: { input: 0.1, output: 0.5, cache_read: 0.01 },
          limit: { context: 1_000_000, output: 128_000 },
          temperature: false,
          last_updated: "2026-10-07",
        },
      },
    },
    openrouter: { models: { "google/gemini-3.5-flash": { cost: { input: 0.3, output: 2.5 } } } },
  };

  it("keeps the fields of the entries of the models used that change a review", async () => {
    const file = write(join(temp(), "models.json"), catalog);
    expect(
      await catalogEntries(file, [
        "openrouter/google/gemini-3.5-flash",
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-haiku-5-5",
        "mine/declared",
        "bare",
      ]),
    ).toEqual({
      "anthropic/claude-haiku-5-5": {
        cost: { input: 0.1, output: 0.5, cache_read: 0.01 },
        limit: { context: 1_000_000, output: 128_000 },
        temperature: false,
        last_updated: "2026-10-07",
      },
      "openrouter/google/gemini-3.5-flash": { cost: { input: 0.3, output: 2.5 } },
    });
  });

  it("is undefined without a catalog to read", async () => {
    expect(await catalogEntries(join(temp(), "missing.json"), ["a/b"])).toBeUndefined();
    expect(await catalogEntries(write(join(temp(), "bad.json"), "{"), ["a/b"])).toBeUndefined();
  });

  it("is read from OpenCode's cache under HOME", () => {
    expect(catalogFile({ HOME: "/home/me", XDG_CACHE_HOME: "/elsewhere" })).toBe(
      join("/home/me", ".cache", "opencode", "models.json"),
    );
  });
});

describe("ranOnFor", () => {
  it("stamps a review with the setup, the time and the entries of its models", async () => {
    const file = write(join(temp(), "models.json"), {
      anthropic: { models: { "claude-haiku-5-5": { cost: { input: 0.1, output: 0.5 } } } },
    });
    const setup = {
      ocra: build,
      runtime: "opencode",
      opencode: { version: "1.18.32" },
      config: { file: "/c.json", sha256: "s" },
    };
    const at = new Date("2026-10-23T12:00:00Z");
    const models = modelsOf({
      ocraVersion: "0.7.0",
      promptHash: "p",
      configHash: "c",
      sampling: {},
      agents: { correctness: { tier: "standard", models: ["anthropic/claude-haiku-5-5"] } },
    });
    expect(await ranOnFor(setup, file, () => at)(models)).toEqual({
      at: "2026-10-23T12:00:00.000Z",
      ocra: build,
      runtime: "opencode",
      opencode: { version: "1.18.32" },
      config: "s",
      catalog: { "anthropic/claude-haiku-5-5": { cost: { input: 0.1, output: 0.5 } } },
    });
    // The direct runtime prices from the configuration, not OpenCode's catalog.
    expect(
      await ranOnFor({ ocra: build, runtime: "direct" }, file, () => at)(models),
    ).not.toHaveProperty("catalog");
  });
});
