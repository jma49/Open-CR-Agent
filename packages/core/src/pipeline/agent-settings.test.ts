import { describe, expect, it } from "vitest";
import { effortWarnings, resolveAgents, reviewerEffort, roleEffort } from "../agent/settings.js";
import type { AgentRuntime, AgentTaskSpec, CompletionRequest } from "../contracts.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { docsReviewer } from "../review/reviewers/docs.js";
import { securityReviewer } from "../review/reviewers/security.js";
import { previewReview } from "./preview.js";
import { agentProvenance } from "./provenance.js";
import { finding, patch, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const reviewers = [correctnessReviewer, securityReviewer, docsReviewer];

describe("effort resolution", () => {
  it("takes an agent's own effort, else its tier's, else none", () => {
    const settings = {
      effort: { standard: "medium", top: "high" } as const,
      reviewerOverrides: { security: { effort: "low" as const } },
      roles: { helper: { effort: "minimal" as const } },
    };
    expect(reviewerEffort(securityReviewer, settings)).toBe("low");
    expect(reviewerEffort(correctnessReviewer, settings)).toBe("medium");
    expect(reviewerEffort(docsReviewer, settings)).toBeUndefined();
    expect(roleEffort("helper", settings)).toBe("minimal");
    expect(roleEffort("judge", settings)).toBe("high");
    expect(roleEffort("verifier", settings)).toBe("medium");
    expect(reviewerEffort(correctnessReviewer, {})).toBeUndefined();
  });

  it("never gives the verifier or judge a reviewer's effort", () => {
    const settings = { reviewerOverrides: { correctness: { effort: "high" as const } } };
    expect(roleEffort("verifier", settings)).toBeUndefined();
    expect(roleEffort("judge", settings)).toBeUndefined();
  });

  it("lists the enabled reviewers and the roles with their tiers", () => {
    const agents = resolveAgents(reviewers, {
      effort: { light: "none" },
      reviewerOverrides: { security: { enabled: false, effort: "high" } },
    });
    expect(agents).toEqual([
      { id: "correctness", tier: "standard" },
      { id: "docs", tier: "light", effort: "none" },
      { id: "verifier", tier: "standard" },
      { id: "judge", tier: "top" },
      { id: "helper", tier: "light", effort: "none" },
    ]);
  });
});

describe("effortWarnings and agentProvenance", () => {
  const agents = [
    { id: "correctness", tier: "standard" as const, effort: "high" as const },
    { id: "judge", tier: "top" as const, effort: "low" as const },
    { id: "helper", tier: "light" as const },
  ];

  it("warns once when the runtime sends no effort, and records it as not applied", () => {
    const runtime = { name: "acme" };
    expect(effortWarnings(agents, runtime)).toEqual([
      "the acme runtime does not apply reasoning effort; the effort configured for correctness, judge was not sent",
    ]);
    expect(agentProvenance(agents, {})).toEqual({
      correctness: { tier: "standard", effort: "high", applied: false },
      judge: { tier: "top", effort: "low", applied: false },
      helper: { tier: "light" },
    });
  });

  it("says nothing when no effort is configured", () => {
    expect(effortWarnings([{ id: "helper", tier: "light" }], { name: "acme" })).toEqual([]);
  });

  it("reports what the runtime applied, and the efforts an endpoint refused", () => {
    const runtime = {
      name: "direct",
      appliedTo: (agent: string) =>
        agent === "correctness"
          ? { effort: true, notApplied: ["temperature" as const] }
          : agent === "judge"
            ? { effort: false }
            : undefined,
    };
    expect(agentProvenance(agents, runtime)).toEqual({
      correctness: { tier: "standard", effort: "high", applied: true, notApplied: ["temperature"] },
      judge: { tier: "top", effort: "low", applied: false },
      helper: { tier: "light" },
    });
    expect(effortWarnings(agents, runtime)).toEqual([
      "the endpoint refused the reasoning effort for judge; those calls were sent again without it",
    ]);
    expect(agentProvenance(agents, { appliedTo: () => undefined }).correctness).toEqual({
      tier: "standard",
      effort: "high",
    });
  });
});

describe("effortWarnings for levels a model does not take", () => {
  it("names the agent, the level and the models once per run, apart from refusals", () => {
    const agents = [
      { id: "security", tier: "standard" as const, effort: "minimal" as const },
      { id: "judge", tier: "top" as const, effort: "high" as const },
    ];
    const runtime = {
      name: "opencode",
      appliedTo: (agent: string) =>
        agent === "security"
          ? { effort: false, unsupported: ["openai/o3", "groq/llama"] }
          : { effort: false },
    };
    expect(effortWarnings(agents, runtime)).toEqual([
      'the opencode runtime did not send reasoning effort "minimal" for security to openai/o3, groq/llama: ocra\'s capability table knows no way to send that level to that model',
      "the endpoint refused the reasoning effort for judge; those calls were sent again without it",
    ]);
    expect(agentProvenance(agents, runtime).security).toEqual({
      tier: "standard",
      effort: "minimal",
      applied: false,
    });
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

describe("review with effort", () => {
  it("sends each agent's effort with every call made on its behalf", async () => {
    const runtime = recording();
    await review({
      vcs: change(),
      runtime,
      reviewers: [correctnessReviewer, securityReviewer],
      ultra: true,
      effort: { standard: "medium", top: "high" },
      reviewerOverrides: { security: { effort: "low" } },
      roles: { helper: { effort: "minimal" }, verifier: { effort: "none" } },
    });
    const taskEfforts = new Set(runtime.tasks.map((t) => `${t.reviewer}:${t.effort}`));
    expect(taskEfforts).toEqual(new Set(["correctness:medium", "security:low"]));

    const byAgent = new Map<string, Set<string | undefined>>();
    for (const call of runtime.calls) {
      const agent = call.agent ?? "(none)";
      byAgent.set(agent, (byAgent.get(agent) ?? new Set()).add(call.effort));
    }
    expect(Object.fromEntries([...byAgent].map(([a, e]) => [a, [...e]]))).toEqual({
      helper: ["minimal"],
      correctness: ["medium"],
      security: ["low"],
      verifier: ["none"],
      judge: ["high"],
    });
  });

  it("sends no effort when none is configured", async () => {
    const runtime = recording();
    await review({ vcs: change(), runtime, reviewers: [correctnessReviewer], ultra: true });
    expect(runtime.tasks.every((t) => !("effort" in t))).toBe(true);
    expect(runtime.calls.length).toBeGreaterThan(0);
    expect(runtime.calls.every((c) => !("effort" in c))).toBe(true);
  });

  it("reports a runtime that applies no effort, once", async () => {
    const runtime = recording();
    const report = await review({
      vcs: change(),
      runtime,
      reviewers: [correctnessReviewer],
      verify: false,
      judge: false,
      effort: { standard: "high" },
      provenance: { ocraVersion: "1", configHash: "c" },
    });
    expect(report.warnings.filter((w) => w.includes("reasoning effort"))).toEqual([
      "the fake runtime does not apply reasoning effort; the effort configured for correctness, verifier was not sent",
    ]);
    expect(report.provenance?.agents?.correctness).toEqual({
      tier: "standard",
      effort: "high",
      applied: false,
    });
  });
});

describe("previewReview with effort", () => {
  it("shows each task's resolved effort", async () => {
    const preview = await previewReview({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      reviewers: [correctnessReviewer, securityReviewer],
      effort: { standard: "medium" },
      reviewerOverrides: { security: { effort: "high" } },
      ultra: true,
    });
    expect(new Set(preview.tasks.map((t) => `${t.reviewer}:${t.effort}`))).toEqual(
      new Set(["correctness:medium", "security:high"]),
    );
    const plain = await previewReview({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      reviewers: [correctnessReviewer],
    });
    expect(plain.tasks[0]).not.toHaveProperty("effort");
  });
});
