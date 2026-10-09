import { describe, expect, it } from "vitest";
import { type CountedReport, reviewerOutcomes } from "./reviewer-outcomes.js";

const task = (
  reviewer: string,
  costUsd: number,
  extra: Partial<CountedReport["tasks"][number]> = {},
) => ({
  reviewer,
  status: "completed" as const,
  usage: { costUsd },
  ...extra,
});

describe("reviewerOutcomes", () => {
  it("counts tasks, failures, findings by severity and cost per reviewer", () => {
    const outcomes = reviewerOutcomes([
      {
        tasks: [
          task("correctness", 0.5),
          task("security", 0.25, { status: "failed" }),
          task("security", 0.25, { status: "timed_out" }),
          task("security", 0, { status: "cancelled" }),
          task("correctness", 9, { reusedFrom: "20261001T100000Z-000001" }),
        ],
        findings: [
          {
            reviewer: "correctness",
            severity: "warning",
            fingerprint: "a",
            verification: "confirmed",
          },
          { reviewer: "security", severity: "critical", fingerprint: "b" },
        ],
      },
    ]);
    expect(Object.keys(outcomes.reviewers)).toEqual(["correctness", "security"]);
    expect(outcomes.reviewers.correctness).toMatchObject({
      tasks: 2,
      failedTasks: 0,
      costUsd: 0.5,
      findings: { critical: 0, warning: 1, suggestion: 0 },
    });
    expect(outcomes.reviewers.security).toMatchObject({
      tasks: 3,
      failedTasks: 2,
      costUsd: 0.5,
      findings: { critical: 1, warning: 0, suggestion: 0 },
    });
    expect(outcomes.verification).toEqual({ confirmed: 1, uncertain: 0, unchecked: 1 });
  });

  it("counts each earlier finding once, a dismissal over a fix in any report, for the reviewer that recorded it", () => {
    const outcomes = reviewerOutcomes([
      {
        tasks: [],
        findings: [{ reviewer: "performance", severity: "warning", fingerprint: "old" }],
        rereview: { fixed: [{ fingerprint: "x", reviewer: "security" }], dismissed: [] },
      },
      {
        tasks: [],
        findings: [],
        rereview: {
          fixed: [{ fingerprint: "y", reviewer: "correctness" }, { fingerprint: "old" }],
          dismissed: [{ fingerprint: "x" }],
        },
      },
    ]);
    expect(outcomes).toMatchObject({ fixed: 2, dismissed: 1 });
    expect(outcomes.reviewers.security).toMatchObject({ fixed: 0, dismissed: 1 });
    expect(outcomes.reviewers.correctness).toMatchObject({ fixed: 1, dismissed: 0 });
    expect(outcomes.reviewers.performance).toMatchObject({ fixed: 1, dismissed: 0 });
  });
});
