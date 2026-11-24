import { describe, expect, it } from "vitest";
import { previewReview } from "./preview.js";
import { runtime, twoFiles, vcs } from "./run.fakes.js";
import { review } from "./run.js";

const done = runtime(async function* (spec) {
  yield { type: "done", taskId: spec.taskId };
});

// The CLI checks its configuration; an embedder calls review() directly.
describe("review() options", () => {
  it.each([
    ["a concurrency that is not a number", { concurrency: Number.NaN }, "concurrency"],
    ["a concurrency of 0", { concurrency: 0 }, "concurrency"],
    ["a negative task timeout", { taskTimeoutMs: -1 }, "taskTimeoutMs"],
    ["a run timeout that is not a number", { runTimeoutMs: Number.NaN }, "runTimeoutMs"],
    ["a negative spend limit", { maxCostUsd: -1 }, "maxCostUsd"],
    ["a fractional task limit", { maxTasks: 1.5 }, "maxTasks"],
  ])("refuses %s before reviewing anything", async (_, limits, field) => {
    const rt = runtime(async function* (spec) {
      yield { type: "done", taskId: spec.taskId };
    });
    const result = review({ vcs: vcs({}, twoFiles), runtime: rt, limits });
    await expect(result).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(result).rejects.toThrow(field);
    expect(rt.specs).toHaveLength(0);
  });

  it("takes no practical limit as Infinity and runs with the defaults when none is given", async () => {
    const unlimited = await review({
      vcs: vcs({}, twoFiles),
      runtime: done,
      limits: { taskTimeoutMs: Infinity, runTimeoutMs: Infinity, maxCostUsd: Infinity },
    });
    expect(unlimited.tasks.map((t) => t.status)).toEqual(["completed"]);
    const defaults = await review({ vcs: vcs({}, twoFiles), runtime: done });
    expect(defaults.tasks.map((t) => t.status)).toEqual(["completed"]);
  });

  it("refuses a guideline scope it does not know", async () => {
    await expect(
      review({ vcs: vcs({}, twoFiles), runtime: done, guidelineScope: "some" as never }),
    ).rejects.toThrow(/guidelineScope/);
  });

  it("refuses to leave out context it does not know", async () => {
    await expect(
      review({ vcs: vcs({}, twoFiles), runtime: done, mode: { without: ["diff" as never] } }),
    ).rejects.toThrow(/unknown context: diff/);
  });

  it("previews each prompt by source, without what the run leaves out", async () => {
    const sources = async (without: ("changed_files" | "description")[]) =>
      (await previewReview({ vcs: vcs({}, twoFiles), mode: { without } })).tasks[0]?.context.map(
        (c) => c.source,
      );
    expect(await sources([])).toEqual([
      "system",
      "change_request",
      "changed_files",
      "diff",
      "reviewer",
      "rules",
      "instructions",
    ]);
    expect(await sources(["changed_files"])).not.toContain("changed_files");
  });

  it("checks the preview's options the same way", async () => {
    await expect(
      previewReview({ vcs: vcs({}, twoFiles), limits: { maxTasks: -1 } }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});
