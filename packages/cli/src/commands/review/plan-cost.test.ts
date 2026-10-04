import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTaskSpec } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";
import { cliPlanOutputSchema } from "./plan-schema.js";

afterEach(removeRepos);

function repo(config: unknown): string {
  const cwd = repoWithChange();
  mkdirSync(join(cwd, ".ocra"), { recursive: true });
  writeFileSync(join(cwd, ".ocra", "config.json"), JSON.stringify(config));
  return cwd;
}

const done = async function* (spec: AgentTaskSpec) {
  yield { type: "done" as const, taskId: spec.taskId };
};

describe("ocra review --plan input cost", () => {
  it("prices each task by its chain's first model, and says what it cannot price", async () => {
    const cwd = repo({
      providers: {
        lab: {
          type: "openai-compatible",
          baseUrl: "https://lab.example/v1",
          models: { big: { input: 3, output: 15 }, free: { input: 0, output: 0 } },
        },
      },
      models: { standard: ["lab/big", "google/std"] },
      reviewers: {
        security: { models: "ocra-openrouter/qwen", minTier: "trivial" },
        performance: { models: "google/std", minTier: "trivial" },
      },
    });
    const json = capture();
    expect(
      await run(["review", "--plan", "--format", "json"], json, capture(), deps(cwd, done)),
    ).toBe(0);
    const plan = JSON.parse(json.text());
    cliPlanOutputSchema.parse(plan);
    const byReviewer = Object.fromEntries(
      plan.tasks.map((t: { reviewer: string; inputCost: unknown }) => [t.reviewer, t.inputCost]),
    );
    const correctness = plan.tasks.find((t: { reviewer: string }) => t.reviewer === "correctness");
    expect(byReviewer).toEqual({
      correctness: {
        model: "lab/big",
        status: "priced",
        usd: ((correctness.promptTokens + (correctness.planPromptTokens ?? 0)) * 3) / 1_000_000,
      },
      security: { model: "ocra-openrouter/qwen", status: "unpriced" },
      performance: { model: "google/std", status: "unknown" },
    });
    expect(plan.inputCost).toEqual({
      usd: byReviewer.correctness.usd,
      priced: 1,
      unpriced: 1,
      unknown: 1,
    });

    const text = capture();
    expect(await run(["review", "--plan"], text, capture(), deps(cwd, done))).toBe(0);
    expect(text.text()).toMatch(
      /correctness-1 .*models lab\/big, google\/std {2}input ~\$0\.\d{4}/,
    );
    expect(text.text()).toMatch(/security-1 .*input unpriced/);
    expect(text.text()).toMatch(/performance-1 .*input price unknown/);
    expect(text.text()).toContain(
      "for the first prompts of 1 of 3 task(s) (1 unpriced, 1 of unknown price)",
    );
    expect(text.text()).toContain("Input only: output");
  });

  it("estimates nothing for a task without a chain", async () => {
    const json = capture();
    await run(["review", "--plan", "--format", "json"], json, capture(), deps(repo({}), done));
    const plan = JSON.parse(json.text());
    cliPlanOutputSchema.parse(plan);
    expect(plan.tasks[0]).not.toHaveProperty("inputCost");
    expect(plan).not.toHaveProperty("inputCost");
    const text = capture();
    await run(["review", "--plan"], text, capture(), deps(repo({}), done));
    expect(text.text()).not.toMatch(/Estimated input cost| {2}input /);
  });
});
