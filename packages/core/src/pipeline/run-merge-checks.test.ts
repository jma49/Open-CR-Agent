import { describe, expect, it } from "vitest";
import type { CompletionRequest, Usage } from "../contracts.js";
import { patch, runtime, twoFiles, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const usage = (costUsd: number): Usage => ({
  inputTokens: 7,
  outputTokens: 3,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd,
});

const mergeChecks = [{ id: "notes", instruction: "The description says who is affected." }];
const answer = JSON.stringify({
  checks: [{ id: "notes", outcome: "failed", reason: "The description is empty." }],
});
const isCheckCall = (r: CompletionRequest) => r.system.includes("pre-merge checks");

function checkerRuntime(costUsd = 0.01) {
  const requests: CompletionRequest[] = [];
  const rt = runtime(async function* (spec) {
    yield { type: "done", taskId: spec.taskId };
  });
  rt.complete = async (request) => {
    requests.push(request);
    return { text: isCheckCall(request) ? answer : "[]", usage: usage(costUsd) };
  };
  return Object.assign(rt, { requests });
}

describe("review with pre-merge checks", () => {
  it("judges none when none is given", async () => {
    const rt = checkerRuntime();
    const report = await reviewWithHooks({ vcs: vcs({}, twoFiles), runtime: rt });
    expect(rt.requests.filter(isCheckCall)).toEqual([]);
    expect(report).not.toHaveProperty("mergeChecks");
  });

  it("puts each outcome in the report and counts what it cost", async () => {
    const rt = checkerRuntime(0.02);
    const report = await reviewWithHooks({ vcs: vcs({}, twoFiles), runtime: rt, mergeChecks });
    expect(report.mergeChecks).toEqual([
      { ...mergeChecks[0], outcome: "failed", reason: "The description is empty." },
    ]);
    expect(rt.requests.filter(isCheckCall)).toHaveLength(1);
    expect(report.usage.costUsd).toBeCloseTo(0.02);
  });

  it("leaves the checks inconclusive once the spend limit is used up", async () => {
    // Grouping four files spends the whole limit before the review starts.
    const rt = checkerRuntime(0.01);
    const four = ["a", "b", "c", "d"].map((n) => patch(`src/${n}.ts`, `const ${n} = 1;`));
    const report = await reviewWithHooks({
      vcs: vcs({}, four.join("\n")),
      runtime: rt,
      mergeChecks,
      limits: { maxCostUsd: 0.01 },
    });
    expect(rt.requests.filter(isCheckCall)).toEqual([]);
    expect(report.mergeChecks).toEqual([
      {
        ...mergeChecks[0],
        outcome: "inconclusive",
        reason: "not judged: the spend limit was reached",
      },
    ]);
    expect(report.warnings).toContain(
      "pre-merge checks were not judged: the spend limit was reached",
    );
  });
});
