import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTaskSpec, OcraPlugin, RuntimeOptions } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudDeps } from "./cloud.js";
import { parseReviewArgs, type ReviewArgs } from "./review/args.js";
import { agentChains, type CliConfig, loadConfig } from "./review/config.js";
import { configHash } from "./review/provenance.js";
import { mergeConfig, remoteConfigSchema } from "./review/remote-config.js";
import { capture, deps, removeRepos, repoWithChange } from "./run.fakes.js";
import { run } from "./run.js";

afterEach(removeRepos);

function repo(config: unknown): string {
  const cwd = repoWithChange();
  mkdirSync(join(cwd, ".ocra"), { recursive: true });
  writeFileSync(join(cwd, ".ocra", "config.json"), JSON.stringify(config));
  return cwd;
}

const own = (config: unknown, warn?: (message: string) => void) =>
  loadConfig(repo(config), {}, { repository: true, ...(warn ? { warn } : {}) });

describe("per-agent model configuration", () => {
  it("reads a chain per reviewer and per role, one model or a list", async () => {
    const config = await own({
      reviewers: { security: { models: "anthropic/opus", effort: "high" } },
      roles: { judge: { models: ["openai/a", "google/b"] }, helper: { models: "google/s" } },
    });
    expect(config.reviewers.security).toEqual({ models: ["anthropic/opus"], effort: "high" });
    expect(config.roles).toEqual({
      judge: { models: ["openai/a", "google/b"] },
      helper: { models: ["google/s"] },
    });
  });

  it.each([
    [{ reviewers: { security: { models: [] } } }],
    [{ reviewers: { security: { models: "" } } }],
    [{ reviewers: { security: { models: 3 } } }],
    [{ roles: { verifier: { models: [""] } } }],
    [{ roles: { planner: { models: "a/b" } } }],
  ])("refuses %j", async (config) => {
    await expect(own(config)).rejects.toThrow(".ocra/config.json is invalid");
  });

  it("warns about an unpriced model only an agent's chain names", async () => {
    const warnings: string[] = [];
    await own(
      {
        providers: {
          lab: {
            type: "openai-compatible",
            baseUrl: "https://lab.example/v1",
            models: { free: { input: 0, output: 0 } },
          },
        },
        roles: { helper: { models: "lab/free" } },
      },
      (m) => warnings.push(m),
    );
    expect(warnings).toEqual([
      "lab/free has a price of 0: reported cost and --max-cost-usd do not count its tokens",
    ]);
  });

  it("merges a shared configuration's chains under the repository's, per agent", () => {
    const shared = remoteConfigSchema.parse({
      reviewers: { security: { models: "a/sec" }, docs: { models: "a/docs" } },
      roles: { judge: { models: "a/judge" } },
    });
    const merged = mergeConfig(shared, {
      reviewers: { security: { models: "b/sec" } },
      roles: { helper: { models: "b/small" } },
    });
    expect(merged.reviewers).toEqual({
      security: { models: "b/sec" },
      docs: { models: "a/docs" },
    });
    expect(merged.roles).toEqual({ judge: { models: "a/judge" }, helper: { models: "b/small" } });
  });

  it("lists the chains of enabled reviewers and of the roles, by agent id", () => {
    expect(
      agentChains({
        reviewers: {
          security: { models: ["a/sec"] },
          docs: { enabled: false, models: ["a/docs"] },
          performance: { effort: "low" },
        },
        roles: { judge: { models: ["a/judge"] }, helper: { effort: "none" } },
      }),
    ).toEqual({ security: ["a/sec"], judge: ["a/judge"] });
  });
});

describe("configHash with per-agent models", () => {
  const args = parseReviewArgs([]) as ReviewArgs;

  it("covers each agent's chain", async () => {
    const config = await loadConfig("/nowhere", {}, { repository: false });
    const variants: Partial<CliConfig>[] = [
      { reviewers: { security: { models: ["a/x"] } } },
      { reviewers: { security: { models: ["a/y"] } } },
      { roles: { judge: { models: ["a/x"] } } },
      { roles: { verifier: { models: ["a/x"] } } },
    ];
    const hashes = variants.map((v) => configHash({ ...config, ...v }, args));
    expect(new Set([configHash(config, args), ...hashes]).size).toBe(5);
  });
});

const NOW = Date.now();

// Signed in to ocra Cloud, which serves an OpenAI-compatible openrouter.
function signedIn(): CloudDeps {
  const dir = mkdtempSync(join(tmpdir(), "ocra-agentmodels-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  mkdirSync(join(dir, "ocra"));
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      server: "https://cloud.test",
      login: "octo",
      access_token: "ocra_cli_t",
      refresh_token: "ocra_ref_r",
      expires_at: NOW + 3_600_000,
    }),
  );
  return {
    env: {},
    fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/providers") {
        return Response.json({
          providers: [{ name: "openrouter", paths: ["/v1/chat/completions"] }],
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    now: Date.now,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
}

describe("ocra review with per-agent models", () => {
  const done = async function* (spec: AgentTaskSpec) {
    yield { type: "done" as const, taskId: spec.taskId };
  };

  it("shows each task's chain in the plan", async () => {
    const cwd = repo({
      models: { standard: ["google/std"] },
      reviewers: { correctness: { models: ["openai/a", "openai/b"] } },
    });
    const out = capture();
    expect(await run(["review", "--plan"], out, capture(), deps(cwd, done))).toBe(0);
    expect(out.text()).toMatch(
      /correctness-1 +~[\d,]+ prompt tokens {2}models openai\/a, openai\/b {2}/,
    );

    const json = capture();
    await run(["review", "--plan", "--format", "json"], json, capture(), deps(cwd, done));
    expect(JSON.parse(json.text()).tasks[0]).toMatchObject({
      reviewer: "correctness",
      models: ["openai/a", "openai/b"],
    });
  });

  it("gives the runtime every agent's chain, declares ocra Cloud models they name, and records them", async () => {
    const cwd = repo({
      models: { standard: ["google/std"], top: ["google/top"] },
      reviewers: { correctness: { models: "ocra-openrouter/qwen" } },
      roles: { judge: { models: ["anthropic/opus"] } },
      verify: false,
    });
    const created: Omit<RuntimeOptions, "tools">[] = [];
    const specs: AgentTaskSpec[] = [];
    const runtimePlugin: OcraPlugin = {
      name: "runtime-opencode",
      configure(ctx) {
        ctx.registerRuntime("opencode", (options) => {
          created.push(options);
          return {
            name: "fake",
            runTask: (spec) => {
              specs.push(spec);
              return done(spec);
            },
          };
        });
      },
    };
    const code = await run(
      ["review", "--no-upload", "--format", "json", "--output", "r.json"],
      capture(),
      capture(),
      deps(cwd, done, {
        cloud: signedIn(),
        runtimes: { opencode: async () => runtimePlugin },
      }),
    );
    expect(code).toBe(0);
    expect(created[0]?.agentModels).toEqual({
      correctness: ["ocra-openrouter/qwen"],
      judge: ["anthropic/opus"],
    });
    expect(created[0]?.providers?.["ocra-openrouter"]).toMatchObject({
      baseUrl: "https://cloud.test/api/gateway/openrouter/v1",
      models: { qwen: { input: 0, output: 0 } },
    });
    expect(specs[0]?.models).toEqual(["ocra-openrouter/qwen"]);
    const report = JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"));
    expect(report.provenance.agents).toMatchObject({
      correctness: { tier: "standard", models: ["ocra-openrouter/qwen"] },
      verifier: { tier: "standard", models: ["google/std"] },
      judge: { tier: "top", models: ["anthropic/opus"] },
      helper: { tier: "light" },
    });
    expect(report.provenance.agents.helper).not.toHaveProperty("models");
  });
});
