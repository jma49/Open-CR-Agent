import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTaskSpec } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { parseReviewArgs, type ReviewArgs } from "./review/args.js";
import { type CliConfig, loadConfig } from "./review/config.js";
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

const own = (config: unknown) => {
  const cwd = repo(config);
  return loadConfig(cwd, {});
};

describe("effort configuration", () => {
  it("reads effort per tier, per reviewer and per role", async () => {
    const config = await own({
      effort: { standard: "medium", top: "high" },
      reviewers: { security: { effort: "high" }, docs: { enabled: false } },
      roles: { judge: { effort: "high" }, helper: { effort: "minimal" } },
    });
    expect(config.effort).toEqual({ standard: "medium", top: "high" });
    expect(config.reviewers.security).toEqual({ effort: "high" });
    expect(config.roles).toEqual({ judge: { effort: "high" }, helper: { effort: "minimal" } });
  });

  it("lets OCRA_EFFORT_<TIER> override a tier's effort", async () => {
    const cwd = repo({ effort: { standard: "medium", light: "low" } });
    const config = await loadConfig(cwd, { OCRA_EFFORT_STANDARD: " high ", OCRA_EFFORT_LIGHT: "" });
    expect(config.effort).toEqual({ standard: "high", light: "low" });
    await expect(loadConfig(cwd, { OCRA_EFFORT_TOP: "max" })).rejects.toThrow(
      "OCRA_EFFORT_TOP must be one of none, minimal, low, medium, high",
    );
  });

  it.each([
    [{ effort: { standard: "max" } }],
    [{ effort: { huge: "high" } }],
    [{ reviewers: { security: { effort: "extreme" } } }],
    [{ roles: { planner: { effort: "high" } } }],
    [{ roles: { judge: { effort: "high", temperature: 1 } } }],
    [{ roles: { judge: "high" } }],
  ])("refuses %j", async (config) => {
    await expect(own(config)).rejects.toThrow(".ocra/config.json is invalid");
  });

  it("reads how a declared provider takes the effort", async () => {
    const provider = (effort?: string) => ({
      providers: {
        router: {
          type: "openai-compatible",
          baseUrl: "https://openrouter.example.com/api/v1",
          models: { m: { input: 1, output: 1 } },
          ...(effort ? { effort } : {}),
        },
      },
    });
    expect((await own(provider("openrouter"))).providers.router?.effort).toBe("openrouter");
    expect((await own(provider())).providers.router).not.toHaveProperty("effort");
    await expect(own(provider("anthropic"))).rejects.toThrow(".ocra/config.json is invalid");
  });

  it("merges a shared configuration's effort and roles under the repository's", () => {
    const shared = remoteConfigSchema.parse({
      effort: { top: "high", light: "low" },
      roles: { judge: { effort: "high" } },
    });
    const merged = mergeConfig(shared, {
      effort: { light: "none" },
      roles: { helper: { effort: "minimal" } },
    });
    expect(merged.effort).toEqual({ top: "high", light: "none" });
    expect(merged.roles).toEqual({ judge: { effort: "high" }, helper: { effort: "minimal" } });
  });
});

describe("configHash with effort", () => {
  const args = parseReviewArgs([]) as ReviewArgs;
  const defaults = () => loadConfig("/nowhere", {}, { repository: false });

  it("covers every effort setting", async () => {
    const config = await defaults();
    const hash = configHash(config, args);
    const variants: Partial<CliConfig>[] = [
      { effort: { top: "high" } },
      { roles: { verifier: { effort: "low" } } },
      { reviewers: { security: { effort: "high" } } },
    ];
    const hashes = variants.map((v) => configHash({ ...config, ...v }, args));
    expect(new Set([hash, ...hashes]).size).toBe(4);
  });

  it("is what it was before effort existed when none is set", async () => {
    // The default configuration's hash as ocra 0.3 computed it.
    expect(configHash(await defaults(), args)).toBe("a8df404aed89c340");
  });
});

describe("ocra review with effort", () => {
  const done = async function* (spec: AgentTaskSpec) {
    yield { type: "done" as const, taskId: spec.taskId };
  };

  it("shows each task's effort in the plan", async () => {
    const cwd = repo({
      effort: { standard: "medium" },
      reviewers: { correctness: { effort: "high" } },
    });
    const out = capture();
    expect(await run(["review", "--plan"], out, capture(), deps(cwd, done))).toBe(0);
    expect(out.text()).toMatch(/correctness-1 +~[\d,]+ prompt tokens {2}effort high {2}/);

    const json = capture();
    await run(["review", "--plan", "--format", "json"], json, capture(), deps(cwd, done));
    expect(JSON.parse(json.text()).tasks[0]).toMatchObject({
      reviewer: "correctness",
      effort: "high",
    });
  });

  it("warns once that a runtime sending no effort did not send it, and records it as not applied", async () => {
    const cwd = repo({ effort: { standard: "high" }, verify: false, judge: false });
    const specs: AgentTaskSpec[] = [];
    const err = capture();
    const code = await run(
      ["review", "--format", "json", "--output", "r.json"],
      capture(),
      err,
      deps(cwd, (spec) => {
        specs.push(spec);
        return done(spec);
      }),
    );
    expect(code).toBe(0);
    expect(specs[0]?.effort).toBe("high");
    const report = JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"));
    const warnings = report.warnings.filter((w: string) => w.includes("reasoning effort"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("does not apply reasoning effort;");
    expect(report.provenance.agents.correctness).toEqual({
      tier: "standard",
      effort: "high",
      applied: false,
    });
    expect(report.provenance.agents.judge).toEqual({ tier: "top" });
  });
});
