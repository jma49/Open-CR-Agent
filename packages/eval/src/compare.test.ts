import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { compareSummaries, comparisonWarnings, type SavedSummary } from "./compare.js";

describe("compareSummaries", () => {
  const saved = (precision: number, cost: number): SavedSummary =>
    ({
      summary: {
        overall: { metrics: { precision, recall: 0.5, f1: 0.5 } },
        costPerReviewedUsd: cost,
        durationSeconds: { median: 60 },
      },
    }) as unknown as SavedSummary;

  it("calls a difference within the baselines' spread no change", () => {
    const rows = compareSummaries(saved(0.3, 1), saved(0.34, 0.5), saved(0.25, 1));
    const row = (name: string) => rows.find((r) => r.metric === name);
    expect(row("Precision")).toMatchObject({ verdict: "no change" });
    expect(row("Cost per reviewed PR ($)")).toMatchObject({ verdict: "better", spread: 0 });
    expect(compareSummaries(saved(0.3, 1), saved(0.2, 1), saved(0.25, 1))[0]).toMatchObject({
      verdict: "worse",
    });
  });

  it("does not judge the direction without a second baseline", () => {
    expect(compareSummaries(saved(0.3, 1), saved(0.9, 1))[0]).toMatchObject({
      verdict: "unknown",
    });
  });

  it("compares run directories from the command line and warns when their PRs differ", async () => {
    const run = async (precision: number, ids: string[]) => {
      const dir = await mkdtemp(join(tmpdir(), "ocra-compare-"));
      await writeFile(join(dir, "summary.json"), JSON.stringify(saved(precision, 1)));
      await writeFile(join(dir, "run.json"), JSON.stringify({ ids }));
      return dir;
    };
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    const code = await main(
      [
        "compare",
        await run(0.3, ["a"]),
        await run(0.5, ["b"]),
        "--spread-of",
        await run(0.28, ["a"]),
      ],
      out,
      out,
    );
    expect(code).toBe(0);
    expect(text).toContain("| Precision | 30.0% | 50.0% | +20.0% | 2.0% | better |");
    expect(text).toContain("Warning: the runs reviewed different PRs");
  });
});

describe("comparisonWarnings", () => {
  const run = (overrides: Record<string, unknown> = {}): SavedSummary =>
    ({
      info: { judge: "j", selection: { dataset: "golden" } },
      summary: {
        instances: { reviewed: 5 },
        golden: { casesHash: "h1", counts: { unadjudicated: 0 } },
      },
      ...overrides,
    }) as unknown as SavedSummary;

  it("names every difference that is not the change under test", () => {
    expect(comparisonWarnings([run(), run()])).toEqual([]);
    expect(
      comparisonWarnings([
        run(),
        run({
          info: { judge: "mock", selection: { dataset: "golden" } },
          summary: {
            instances: { reviewed: 4 },
            golden: { casesHash: "h2", counts: { unadjudicated: 2 } },
          },
        }),
      ]),
    ).toEqual([
      "the runs were scored by different judges",
      "the runs reviewed a different number of PRs (failed ones are not scored)",
      "the runs were scored against different golden cases or labels; rescore them",
      "some findings are unlabeled, which lowers golden precision until labeled",
    ]);
  });
});
