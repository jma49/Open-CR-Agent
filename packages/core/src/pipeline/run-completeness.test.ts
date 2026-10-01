import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../contracts.js";
import { CompletionError } from "../errors.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { finding, patch, runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };
const reviewer = (id: string): ReviewerDefinition => ({
  id,
  category: id,
  modelTier: "standard",
  systemPrompt: "",
});
const done = runtime(async function* (spec) {
  yield { type: "done", taskId: spec.taskId };
});

describe("review completeness", () => {
  it("reports files as not reviewed when the task limit cut one of their reviewers", async () => {
    const report = await review({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      runtime: done,
      reviewers: [reviewer("correctness"), reviewer("security")],
      maxTasks: 1,
    });
    expect(report.tasks.map((t) => t.reviewer)).toEqual(["correctness"]);
    expect(report.coverage.map((c) => c.status)).toEqual(["unreviewed"]);
  });

  it("keeps the verdict and summary when one reviewer finished and another failed (#263)", async () => {
    const report = await review({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      runtime: runtime(async function* (spec) {
        if (spec.reviewer === "security") {
          yield { type: "error", taskId: spec.taskId, error: "boom", retryable: false };
          return;
        }
        yield {
          type: "finding",
          taskId: spec.taskId,
          finding: finding("src/a.ts", "const a = 1;"),
        };
        yield { type: "done", taskId: spec.taskId };
      }),
      reviewers: [reviewer("correctness"), reviewer("security")],
      verify: false,
      judge: false,
    });
    // The file is not fully reviewed, so the run is incomplete, but the
    // correctness review happened and its finding stands.
    expect(report.coverage.map((c) => c.status)).toEqual(["failed"]);
    expect(report.findings).toHaveLength(1);
    expect(report.summary).not.toContain("Nothing was reviewed");
  });

  it("counts a critical Verify could not check even when the judge drops it", async () => {
    const dropping: AgentRuntime = {
      ...runtime(async function* (spec) {
        yield {
          type: "finding",
          taskId: spec.taskId,
          finding: finding("src/a.ts", "const a = 1;", { severity: "critical" }),
        };
        yield { type: "done", taskId: spec.taskId };
      }),
      complete: async (request) => {
        if (request.tier === "standard") throw new CompletionError("verifier down", usage);
        return { text: '{"drop":[{"index":0,"reason":"the author says it is fine"}]}', usage };
      },
    };
    const report = await review({ vcs: vcs({}, twoFiles), runtime: dropping });
    expect(report.findings).toEqual([]);
    expect(report.unverifiedCriticals).toBe(1);
  });

  it("starts no further task once the run is cancelled", async () => {
    const controller = new AbortController();
    const many = Array.from({ length: 6 }, (_, i) => patch(`src/f${i}.ts`, `const f = ${i};`));
    const rt = runtime(async function* (spec) {
      controller.abort();
      yield { type: "done", taskId: spec.taskId };
    });
    const report = await review({
      vcs: vcs({}, many.join("\n")),
      runtime: rt,
      signal: controller.signal,
      concurrency: 1,
      abortGraceMs: 10,
      bundling: { groupingMinFiles: 100, maxFilesPerBundle: 1, maxBundleChars: 100_000 },
    });
    expect(rt.specs).toHaveLength(1);
    expect(
      report.tasks.filter((t) => t.error === "run cancelled before this task started"),
    ).toHaveLength(5);
  });

  it("says earlier findings are still open when nothing new was found", async () => {
    const adapter = vcs({ "src/a.ts": "keep\nconst a = 1;\n" }, twoFiles);
    adapter.getPriorReview = async () => ({
      findings: [
        {
          fingerprint: "0123456789abcdef",
          title: "t",
          file: "src/a.ts",
          severity: "critical",
          commented: true,
          verification: "confirmed",
        },
      ],
    });
    const report = await review({ vcs: adapter, runtime: done, verify: false });
    expect(report.verdict).toBe("significant_concerns");
    expect(report.summary).toBe("No new issues; 1 earlier finding(s) are still open.");
  });
});
