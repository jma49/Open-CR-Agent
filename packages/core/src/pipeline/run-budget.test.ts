import { describe, expect, it } from "vitest";
import type { AgentRuntime, CompletionRequest, Usage } from "../contracts.js";
import { REVIEW_BUDGET_SHARE } from "./budget.js";
import { finding, patch, runtime, vcs } from "./run.fakes.js";
import { runReview } from "./run.js";

const usage = (costUsd: number): Usage => ({
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd,
});

function files(count: number) {
  return Array.from({ length: count }, (_, i) => patch(`src/f${i}.ts`, `const v${i} = 1;`)).join(
    "\n",
  );
}

// Every task reports one finding on its file and costs taskCost; Verify
// confirms everything for callCost, the judge changes nothing.
function pricedRuntime(taskCost: number, callCost = 0.01) {
  const requests: CompletionRequest[] = [];
  const rt = runtime(async function* (spec) {
    // One file per bundle, in order: task correctness-<n> reviews file n-1.
    const n = Number(spec.taskId.split("-")[1]) - 1;
    const file = `src/f${n}.ts`;
    yield { type: "finding", taskId: spec.taskId, finding: finding(file, `const v${n} = 1;`) };
    yield { type: "usage", taskId: spec.taskId, ...usage(taskCost) };
    yield { type: "done", taskId: spec.taskId };
  });
  const complete: AgentRuntime["complete"] = async (request) => {
    requests.push(request);
    const text = request.tier === "top" ? "{}" : '[{"index":0,"verdict":"confirmed"}]';
    return { text, usage: usage(callCost) };
  };
  return Object.assign(rt, { complete, requests });
}

const perFile = { groupingMinFiles: 10, maxFilesPerBundle: 1, maxBundleChars: 1_000_000 };

describe("runReview with a spend limit", () => {
  it("stops starting review tasks at the review share of the limit", async () => {
    expect(REVIEW_BUDGET_SHARE).toBe(0.8);
    const report = await runReview({
      vcs: vcs({}, files(4)),
      runtime: pricedRuntime(0.3),
      bundling: perFile,
      concurrency: 1,
      maxCostUsd: 1,
    });
    // $0.9 after three tasks: past $0.8, so the fourth never starts.
    expect(report.tasks.map((t) => t.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "cancelled",
    ]);
    expect(report.tasks[3]?.error).toBe("spend limit of $1 reached");
    expect(report.coverage.map((c) => c.status)).toEqual([
      "reviewed",
      "reviewed",
      "reviewed",
      "failed",
    ]);
  });

  it("verifies and judges with the reserved rest", async () => {
    const rt = pricedRuntime(0.3);
    const report = await runReview({
      vcs: vcs({}, files(3)),
      runtime: rt,
      bundling: perFile,
      concurrency: 1,
      maxCostUsd: 1,
    });
    expect(report.findings.map((f) => f.verification)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
    ]);
    expect(rt.requests.map((r) => r.tier)).toEqual(["standard", "standard", "standard", "top"]);
    expect(report.warnings).toEqual([]);
  });

  it("leaves findings unchecked, and says so, when nothing is left", async () => {
    const rt = pricedRuntime(0.6);
    const report = await runReview({
      vcs: vcs({}, files(2)),
      runtime: rt,
      bundling: perFile,
      concurrency: 1,
      maxCostUsd: 1,
    });
    expect(rt.requests).toEqual([]);
    expect(report.findings.map((f) => f.verification)).toEqual(["unchecked", "unchecked"]);
    expect(report.warnings).toEqual([
      "spend limit reached: 2 finding(s) were not verified and cannot block",
      "spend limit of $1 reached: findings were not judged",
    ]);
  });

  it("does not verify findings that memory or a reviewer's dismissal removes", async () => {
    const first = await runReview({
      vcs: vcs({}, files(2)),
      runtime: pricedRuntime(0),
      bundling: perFile,
      verify: false,
      judge: false,
    });
    const [remembered, dismissed] = first.findings;
    const memory = JSON.stringify({
      accepted: [
        { fingerprint: remembered?.fingerprint, file: remembered?.file, title: "t", reason: "ok" },
      ],
    });
    const adapter = vcs({}, files(2));
    adapter.getPriorReview = async () => ({
      findings: [
        {
          fingerprint: dismissed?.fingerprint ?? "",
          title: "t",
          file: dismissed?.file ?? "",
          severity: "warning",
          commented: true,
          dismissed: true,
        },
      ],
    });
    const rt = pricedRuntime(0);
    const report = await runReview({
      vcs: adapter,
      runtime: rt,
      bundling: perFile,
      readTrusted: async (path) => (path === ".ocra/memory.json" ? memory : undefined),
    });
    expect(report.findings).toEqual([]);
    expect(report.remembered).toHaveLength(1);
    expect(report.rereview?.dismissed).toHaveLength(1);
    expect(rt.requests).toEqual([]);
  });
});
