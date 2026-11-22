import { describe, expect, it } from "vitest";
import { renderContext, summarizeContext } from "./context.js";

describe("summarizeContext", () => {
  const summary = summarizeContext([
    {
      id: "a",
      tasks: [
        {
          promptTokens: 300,
          context: [
            { source: "diff", tokens: 200 },
            { source: "guidelines", tokens: 100, cut: 1, duplicateTokens: 10 },
          ],
        },
        { promptTokens: 100, context: [{ source: "diff", tokens: 100 }] },
      ],
    },
  ]);

  it("sums each source over the tasks that have it", () => {
    expect(summary).toMatchObject({ cases: 1, tasks: 2, promptTokens: 400 });
    expect(summary.sources.find((s) => s.source === "diff")).toMatchObject({
      tasks: 2,
      tokens: 300,
      meanPerTask: 150,
      maxPerTask: 200,
    });
    expect(summary.sources.find((s) => s.source === "guidelines")).toMatchObject({
      tasks: 1,
      cut: 1,
      duplicateTokens: 10,
    });
    expect(summary.sources.find((s) => s.source === "learnings")?.tasks).toBe(0);
  });

  it("renders one row per source with its share of the prompts", () => {
    const text = renderContext(summary, "left out: learnings");
    expect(text).toContain("| diff | 2 | 300 | 75.0% | 150 | 200 | 0 | 0 |");
    expect(text).toContain("Context: left out: learnings.");
  });
});
