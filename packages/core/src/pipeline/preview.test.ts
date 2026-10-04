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
});
