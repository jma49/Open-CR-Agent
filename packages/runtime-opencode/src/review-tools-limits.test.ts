import type { ReviewContext } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { MAX_LINE_CHARS, MAX_RESULT_CHARS, reviewTools } from "./review-tools.js";

function run(name: string, args: Record<string, unknown>, context: Partial<ReviewContext>) {
  const tool = reviewTools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  const full: ReviewContext = {
    readFile: async () => undefined,
    readDiff: () => undefined,
    searchCode: async () => [],
    ...context,
  };
  return tool.execute(args, full).then(String);
}

describe("review tool limits", () => {
  it("clips a minified line and keeps the result within its size cap", async () => {
    const minified = "x".repeat(5_000_000);
    const result = await run(
      "read_file",
      { path: "app.min.js" },
      { readFile: async () => minified },
    );
    expect(result.length).toBeLessThan(MAX_LINE_CHARS + 100);
    expect(result).toContain(`[${5_000_000 - MAX_LINE_CHARS} more characters]`);
  });

  it("pages a file by size as well as by lines, and says where to continue", async () => {
    const content = Array.from({ length: 300 }, () => "y".repeat(1_000)).join("\n");
    const result = await run("read_file", { path: "a.json" }, { readFile: async () => content });
    expect(result.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 200);
    const shown = result.split("\n").length - 1;
    expect(result).toContain(`call again with startLine=${shown + 1}]`);
  });

  it("caps diffs and search results", async () => {
    const huge = Array.from({ length: 1_000 }, () => `+${"z".repeat(500)}`).join("\n");
    const diff = await run("read_diff", { path: "a.ts" }, { readDiff: () => huge });
    expect(diff.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 100);
    expect(diff).toMatch(/\[diff truncated after \d+ lines\]$/);

    const matches = Array.from({ length: 80 }, (_, i) => ({
      path: "a.js",
      line: i + 1,
      text: "q".repeat(100_000),
    }));
    const found = await run("code_search", { literal: "qq" }, { searchCode: async () => matches });
    expect(found.length).toBeLessThanOrEqual(MAX_RESULT_CHARS + 100);
    expect(found).toContain("[30 more matches omitted]");
  });
});
