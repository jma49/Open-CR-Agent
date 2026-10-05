import { describe, expect, it } from "vitest";
import type { ReviewEvent } from "../report/report.js";
import { runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const summary = {
  model: "p/m",
  read: ["src/a.ts", "src/lib.ts"],
  searched: ["parseConfig("],
  text: "src/b.ts only renames a variable; nothing to report.",
};

describe("an attempt's summary in the session events", () => {
  it("keeps which files the attempt read, what it searched for and its answer, out of the report", async () => {
    const events: ReviewEvent[] = [];
    const report = await review({
      vcs: vcs({}, twoFiles),
      runtime: runtime(async function* (spec) {
        yield {
          type: "progress",
          taskId: spec.taskId,
          message: "p/m: 3 step(s)",
          attempt: summary,
        };
        yield { type: "done", taskId: spec.taskId };
      }),
      stages: { verify: false, judge: false },
      onEvent: (e) => events.push(e),
    });
    const progress = events.filter((e) => e.type === "task_progress");
    expect(progress).toContainEqual({
      type: "task_progress",
      taskId: report.tasks[0]?.taskId,
      message: "p/m: 3 step(s)",
      attempt: summary,
    });
    expect(JSON.stringify(report)).not.toContain("parseConfig(");
    expect(JSON.stringify(report)).not.toContain("renames a variable");
  });
});
