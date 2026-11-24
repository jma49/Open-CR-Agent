import { describe, expect, it } from "vitest";
import { runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const done = async function* (spec: { taskId: string }) {
  yield { type: "done" as const, taskId: spec.taskId };
};

describe("the coding agent behind a review", () => {
  it("is on the report when the runtime names one", async () => {
    const report = await review({
      vcs: vcs({}, twoFiles),
      runtime: { ...runtime(done), agent: "Codex" },
      stages: { verify: false, judge: false },
    });
    expect(report.agent).toBe("Codex");
  });

  it("is absent when ocra's own engine ran the review", async () => {
    const report = await review({
      vcs: vcs({}, twoFiles),
      runtime: runtime(done),
      stages: { verify: false, judge: false },
    });
    expect(report.agent).toBeUndefined();
  });
});
