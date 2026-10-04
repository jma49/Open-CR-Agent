import { describe, expect, it } from "vitest";
import type { AgentRuntime, AgentTaskSpec, CompletionRequest } from "../contracts.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { docsReviewer } from "../review/reviewers/docs.js";
import { securityReviewer } from "../review/reviewers/security.js";
import { resolveAgents, reviewerCall, roleCall } from "./agents.js";
import { previewReview } from "./preview.js";
import { agentProvenance } from "./provenance.js";
import { finding, patch, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const tiers = { top: ["t/top"], standard: ["t/std"], light: ["t/light"] };

describe("model chain resolution", () => {
  it("gives a reviewer's and a role's calls their own chain, and nothing else a chain", () => {
    const settings = {
      models: tiers,
      reviewerOverrides: { security: { models: ["a/sec", "b/sec"] } },
      roles: { helper: { models: ["a/small"] } },
    };
    expect(reviewerCall(securityReviewer, settings)).toEqual({ models: ["a/sec", "b/sec"] });
    expect(reviewerCall(correctnessReviewer, settings)).toEqual({});
    expect(roleCall("helper", settings)).toEqual({ models: ["a/small"] });
    expect(roleCall("verifier", settings)).toEqual({});
  });

  it("never gives the verifier or judge a reviewer's chain", () => {
    const settings = {
      reviewerOverrides: { correctness: { models: ["a/x"] }, verifier: { models: ["a/y"] } },
    };
    expect(roleCall("verifier", settings)).toEqual({});
    expect(roleCall("judge", settings)).toEqual({});
  });

  it("records each agent's own chain, else its tier's, else none", () => {
    const agents = resolveAgents([correctnessReviewer, securityReviewer, docsReviewer], {
      models: { standard: ["t/std"] },
      reviewerOverrides: {
        security: { models: ["a/sec"] },
        docs: { enabled: false, models: ["a/docs"] },
      },
      roles: { judge: { models: ["a/judge"] } },
    });
    expect(agents).toEqual([
      { id: "correctness", tier: "standard", models: ["t/std"] },
      { id: "security", tier: "standard", models: ["a/sec"] },
      { id: "verifier", tier: "standard", models: ["t/std"] },
      { id: "judge", tier: "top", models: ["a/judge"] },
      { id: "helper", tier: "light" },
    ]);
    expect(agentProvenance(agents, {}).security).toEqual({ tier: "standard", models: ["a/sec"] });
    expect(agentProvenance(agents, {}).helper).toEqual({ tier: "light" });
  });
});

const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
const change = () => vcs({}, files.map((f, i) => patch(f, `const v${i} = ${i};`)).join("\n"));

function recording(): AgentRuntime & { tasks: AgentTaskSpec[]; calls: CompletionRequest[] } {
  const tasks: AgentTaskSpec[] = [];
  const calls: CompletionRequest[] = [];
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    reasoningTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
  };
  return {
    name: "fake",
    tasks,
    calls,
    async *runTask(spec) {
      tasks.push(spec);
      if (spec.taskId.startsWith("correctness") && !spec.taskId.endsWith("b")) {
        // A quote that matches nothing, so anchoring asks a helper.
        const reported = finding("src/a.ts", "const nothing = here;", { severity: "critical" });
        yield { type: "finding", taskId: spec.taskId, finding: reported };
      }
      yield { type: "done", taskId: spec.taskId };
    },
    async complete(request) {
      calls.push(request);
      return { text: "NONE", usage };
    },
  };
}

function chainsByAgent(calls: readonly CompletionRequest[]): Record<string, string[]> {
  const byAgent = new Map<string, Set<string>>();
  for (const call of calls) {
    const agent = call.agent ?? "(none)";
    byAgent.set(agent, (byAgent.get(agent) ?? new Set()).add(call.models?.join(">") ?? "tier"));
  }
  return Object.fromEntries([...byAgent].map(([a, chains]) => [a, [...chains]]));
}

describe("review with per-agent models", () => {
  it("sends an agent's own chain with every call made on its behalf, and only its", async () => {
    const runtime = recording();
    const report = await review({
      vcs: change(),
      runtime,
      reviewers: [correctnessReviewer, securityReviewer],
      ultra: true,
      models: tiers,
      reviewerOverrides: { correctness: { models: ["a/c1", "a/c2"] } },
      roles: { helper: { models: ["a/small"] }, judge: { models: ["a/judge"] } },
      provenance: { ocraVersion: "1", configHash: "c" },
    });
    const taskChains = new Set(runtime.tasks.map((t) => `${t.reviewer}:${t.models ?? "tier"}`));
    expect(taskChains).toEqual(new Set(["correctness:a/c1,a/c2", "security:tier"]));
    // Plan calls run on the reviewer's chain; the verifier keeps its tier's.
    expect(chainsByAgent(runtime.calls)).toEqual({
      helper: ["a/small"],
      correctness: ["a/c1>a/c2"],
      security: ["tier"],
      verifier: ["tier"],
      judge: ["a/judge"],
    });
    expect(report.provenance?.agents).toMatchObject({
      correctness: { tier: "standard", models: ["a/c1", "a/c2"] },
      security: { tier: "standard", models: ["t/std"] },
      verifier: { tier: "standard", models: ["t/std"] },
      judge: { tier: "top", models: ["a/judge"] },
      helper: { tier: "light", models: ["a/small"] },
    });
  });

  it("sends no chain when no agent has one", async () => {
    const runtime = recording();
    const report = await review({
      vcs: change(),
      runtime,
      reviewers: [correctnessReviewer],
      ultra: true,
      provenance: { ocraVersion: "1", configHash: "c" },
    });
    expect(runtime.tasks.every((t) => !("models" in t))).toBe(true);
    expect(runtime.calls.length).toBeGreaterThan(0);
    expect(runtime.calls.every((c) => !("models" in c))).toBe(true);
    expect(report.provenance?.agents?.correctness).toEqual({ tier: "standard" });
  });
});

describe("previewReview with per-agent models", () => {
  it("shows each task's resolved chain", async () => {
    const preview = await previewReview({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      reviewers: [correctnessReviewer, securityReviewer],
      models: { standard: ["t/std", "t/std2"] },
      reviewerOverrides: { security: { models: ["a/sec"] } },
      ultra: true,
    });
    expect(Object.fromEntries(preview.tasks.map((t) => [t.reviewer, t.models]))).toEqual({
      correctness: ["t/std", "t/std2"],
      security: ["a/sec"],
    });
    const plain = await previewReview({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      reviewers: [correctnessReviewer],
    });
    expect(plain.tasks[0]).not.toHaveProperty("models");
  });

  it("estimates input cost at the input price of each chain's first model", async () => {
    const prices: Record<string, number> = { "t/std": 2, "a/sec": 0 };
    const preview = await previewReview({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      reviewers: [correctnessReviewer, securityReviewer, docsReviewer],
      reviewerOverrides: {
        security: { models: ["a/sec", "t/std"], minTier: "trivial" },
        docs: { models: ["x/catalog"], minTier: "trivial" },
      },
      models: { standard: ["t/std", "a/sec"] },
      inputPrice: (model) => prices[model],
    });
    const correctness = preview.tasks.find((t) => t.reviewer === "correctness");
    const tokens = (correctness?.promptTokens ?? 0) + (correctness?.planPromptTokens ?? 0);
    expect(Object.fromEntries(preview.tasks.map((t) => [t.reviewer, t.inputCost]))).toEqual({
      correctness: { model: "t/std", status: "priced", usd: (tokens * 2) / 1_000_000 },
      security: { model: "a/sec", status: "unpriced" },
      docs: { model: "x/catalog", status: "unknown" },
    });
    expect(preview.inputCost).toEqual({
      usd: (tokens * 2) / 1_000_000,
      priced: 1,
      unpriced: 1,
      unknown: 1,
    });
  });
});
