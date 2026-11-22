import { describe, expect, it } from "vitest";
import type { CompletionRequest } from "../contracts.js";
import { braceSyntax, usage } from "../fix/fix.fakes.js";
import type { ReviewEvent } from "../report/report.js";
import { finding, patch, runtime, vcs } from "./run.fakes.js";
import { reviewWithHooks } from "./run.js";

const files = { "src/a.ts": "keep\nconst a = 1;" };
const diff = patch("src/a.ts", "const a = 1;");

function fixingRuntime() {
  const requests: CompletionRequest[] = [];
  const rt = runtime(async function* (spec) {
    yield { type: "finding", taskId: spec.taskId, finding: finding("src/a.ts", "const a = 1;") };
    yield { type: "done", taskId: spec.taskId };
  });
  rt.complete = async (request) => {
    requests.push(request);
    const text =
      request.agent === "fixer"
        ? JSON.stringify([{ index: 0, replacement: "const a = 2;" }])
        : "[]";
    return { text, usage: { ...usage, costUsd: request.agent === "fixer" ? 0.03 : 0 } };
  };
  return Object.assign(rt, { requests });
}

describe("review with fixes", () => {
  it("proposes none unless asked", async () => {
    const rt = fixingRuntime();
    const report = await reviewWithHooks({
      vcs: vcs(files, diff),
      runtime: rt,
      syntax: braceSyntax,
    });
    expect(rt.requests.filter((r) => r.agent === "fixer")).toEqual([]);
    expect(report.findings[0]).not.toHaveProperty("fix");
    expect(report).not.toHaveProperty("fixes");
  });

  it("puts a checked fix on the finding and counts what it cost", async () => {
    const rt = fixingRuntime();
    const events: ReviewEvent[] = [];
    const report = await reviewWithHooks({
      vcs: vcs(files, diff),
      runtime: rt,
      syntax: braceSyntax,
      stages: { fixes: true },
      onEvent: (e) => events.push(e),
    });
    expect(report.findings[0]?.fix).toEqual({
      startLine: 2,
      endLine: 2,
      replacement: "const a = 2;",
    });
    expect(report.fixes).toEqual({ asked: 1, proposed: 1, rejected: [] });
    expect(report.usage.costUsd).toBeCloseTo(0.03);
    expect(events).toContainEqual({ type: "stage_started", stage: "fix" });
  });

  it("proposes none without a syntax checker, and says so", async () => {
    const rt = fixingRuntime();
    const report = await reviewWithHooks({
      vcs: vcs(files, diff),
      runtime: rt,
      stages: { fixes: true },
    });
    expect(rt.requests.filter((r) => r.agent === "fixer")).toEqual([]);
    expect(report.warnings).toContain(
      "fixes were asked for, but no syntax checker was given: none was proposed",
    );
  });
});
