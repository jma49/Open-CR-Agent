import { describe, expect, it } from "vitest";
import { finding, patch, runtime, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const twoFindings = runtime(async function* (spec) {
  yield {
    type: "finding",
    taskId: spec.taskId,
    finding: finding("src/a.ts", "const a = 1;", { severity: "suggestion", title: "Minor" }),
  };
  yield {
    type: "finding",
    taskId: spec.taskId,
    finding: finding("src/b.ts", "const b = 2;", { severity: "critical", title: "Major" }),
  };
  yield { type: "done", taskId: spec.taskId };
});

describe("the inline comment policy", () => {
  it("keeps every finding in the report and names the ones held back from inline comments", async () => {
    const report = await review({
      vcs: vcs({}, `${patch("src/a.ts", "const a = 1;")}\n${patch("src/b.ts", "const b = 2;")}`),
      runtime: twoFindings,
      stages: { verify: false, judge: false },
      inline: { minSeverity: "warning" },
    });
    expect(report.findings.map((f) => f.title).sort()).toEqual(["Major", "Minor"]);
    const minor = report.findings.find((f) => f.title === "Minor");
    expect(report.inline).toEqual({
      minSeverity: "warning",
      held: [{ fingerprint: minor?.fingerprint, reason: "below_floor" }],
    });
  });

  it("is absent from a report without one", async () => {
    const report = await review({
      vcs: vcs({}, `${patch("src/a.ts", "const a = 1;")}\n${patch("src/b.ts", "const b = 2;")}`),
      runtime: twoFindings,
      stages: { verify: false, judge: false },
    });
    expect(report.inline).toBeUndefined();
  });
});
