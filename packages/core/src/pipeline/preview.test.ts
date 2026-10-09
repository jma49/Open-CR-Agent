import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "../diff/parse.js";
import type { VcsAdapter } from "../vcs.js";
import { previewReview } from "./preview.js";

function patch(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1,2 @@",
    " a",
    "+b",
  ].join("\n");
}

function vcs(paths: string[]): VcsAdapter {
  return {
    name: "fake",
    getChangeRequest: async () => ({
      id: "1",
      title: "Change",
      description: "",
      baseSha: "b",
      headSha: "h",
    }),
    getDiff: async () => parseUnifiedDiff(paths.map(patch).join("\n")),
    readFile: async () => undefined,
    searchCode: async () => [],
    getPriorReview: async () => undefined,
    publish: async () => ({ warnings: [] }),
  };
}

describe("previewReview", () => {
  it("keeps the default for each selection field left out", async () => {
    const huge = patch("src/huge.ts").replace("+b", `+${"x".repeat(200_001)}`);
    const preview = await previewReview({
      vcs: {
        ...vcs([]),
        getDiff: async () =>
          parseUnifiedDiff([patch("src/a.ts"), patch("src/b.ts"), huge].join("\n")),
      },
      selection: { exclude: ["src/b.ts"] },
    });
    expect(preview.selected).toEqual(["src/a.ts"]);
    expect(preview.excluded).toEqual([
      { path: "src/b.ts", reason: "user_exclude" },
      { path: "src/huge.ts", reason: "too_large" },
    ]);
  });

  it("plans files, bundles and tasks with prompt sizes and no model", async () => {
    const preview = await previewReview({
      vcs: vcs(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "package-lock.json"]),
    });
    expect(preview.selected).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
    expect(preview.excluded).toEqual([{ path: "package-lock.json", reason: "generated" }]);
    expect(preview.groupingSkipped).toBe(true);
    expect(preview.tasks.map((t) => t.taskId)).toEqual([
      "correctness-1",
      "correctness-2",
      "correctness-3",
      "correctness-4",
    ]);
    expect(preview.tasks.every((t) => t.promptTokens > 500)).toBe(true);
    expect(preview.promptTokens).toBe(preview.tasks.reduce((sum, t) => sum + t.promptTokens, 0));
  });

  it("doubles the tasks in ultra mode", async () => {
    const preview = await previewReview({ vcs: vcs(["src/a.ts"]), mode: { ultra: true } });
    expect(preview.tasks.map((t) => t.taskId)).toEqual(["correctness-1", "correctness-1b"]);
    expect(preview.groupingSkipped).toBe(false);
  });

  // The run reviews only what changed since its prior review; the plan of
  // the same change request says and does the same.
  it("plans only what changed since the prior review, as the run does", async () => {
    const withPrior = (prior: Awaited<ReturnType<VcsAdapter["getPriorReview"]>>): VcsAdapter => ({
      ...vcs(["src/a.ts", "src/b.ts"]),
      getPriorReview: async () => prior,
    });
    const incremental = await previewReview({
      vcs: withPrior({ findings: [], changedSince: { head: "h0", files: ["src/b.ts"] } }),
    });
    expect(incremental.scope).toEqual({ mode: "incremental", since: "h0" });
    expect(incremental.selected).toEqual(["src/a.ts", "src/b.ts"]);
    expect(incremental.tasks.map((t) => t.files)).toEqual([["src/b.ts"]]);

    const full = await previewReview({
      vcs: withPrior({ findings: [], changedSince: { head: "h0", files: ["src/b.ts"] } }),
      mode: { full: true },
    });
    expect(full.scope).toEqual({ mode: "full", reason: "a full review was requested" });
    expect(full.tasks.flatMap((t) => t.files)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("warns and plans everything when the prior review cannot be read", async () => {
    const preview = await previewReview({
      vcs: {
        ...vcs(["src/a.ts"]),
        getPriorReview: async () => {
          throw new Error("rate limited");
        },
      },
    });
    expect(preview.scope).toBeUndefined();
    expect(preview.warnings).toContain("could not load the previous review: rate limited");
    expect(preview.tasks.flatMap((t) => t.files)).toEqual(["src/a.ts"]);
  });
});
