import { describe, expect, it } from "vitest";
import type { AgentRuntime } from "../contracts.js";
import { finding, patch, runtime, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 };

// One critical finding, which the verifier confirms and traces to code that
// was there before the change.
const preExisting: AgentRuntime = {
  ...runtime(async function* (spec) {
    yield {
      type: "finding",
      taskId: spec.taskId,
      finding: finding("src/a.ts", "const a = 1;", { severity: "critical" }),
    };
    yield { type: "done", taskId: spec.taskId };
  }),
  complete: async () => ({
    text: '[{"index":0,"verdict":"confirmed","reason":"was there","origin":"pre_existing"}]',
    usage,
  }),
};

describe("pre-existing findings", () => {
  it("are shown, marked, and never block", async () => {
    const report = await review({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      runtime: preExisting,
      stages: { judge: false },
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ verification: "confirmed", preExisting: true });
    expect(report.verdict).toBe("approved_with_comments");
  });

  it("are left out of the report when showPreExisting is false", async () => {
    const report = await review({
      vcs: vcs({}, patch("src/a.ts", "const a = 1;")),
      runtime: preExisting,
      stages: { judge: false, showPreExisting: false },
    });
    expect(report.findings).toEqual([]);
    expect(report.verdict).toBe("approved");
    expect(report.warnings).toContain(
      "1 pre-existing finding(s) not shown (showPreExisting is false)",
    );
  });
});
