import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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

// A golden run of one case whose expected findings were found as `found`.
const golden = (found: boolean[], casesHash = "h1", recall = 0): SavedSummary =>
  ({
    summary: {
      overall: { metrics: { precision: 0.5, recall: 0.5, f1: 0.5 } },
      costPerReviewedUsd: 1,
      durationSeconds: { median: 60 },
      golden: {
        precision: 0.5,
        recall,
        failures: [],
        counts: { unadjudicated: 0 },
        casesHash,
        cases: {
          c: {
            expected: found.length,
            found: found.filter(Boolean).length,
            reported: 1,
            right: 1,
            claims: found.map((f, k) => ({ concern: `claim ${k + 1} | x`, found: f })),
          },
        },
      },
    },
  }) as unknown as SavedSummary;

describe("ocra-eval compare on repeated golden runs", () => {
  const repeated = async (runs: SavedSummary[]) => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-compare-claims-"));
    await writeFile(
      join(dir, "repeats.json"),
      JSON.stringify({ repeat: runs.length, runs: runs.map((_, n) => `r${n + 1}`) }),
    );
    for (const [n, saved] of runs.entries()) {
      await mkdir(join(dir, `r${n + 1}`));
      await writeFile(join(dir, `r${n + 1}`, "summary.json"), JSON.stringify(saved));
      await writeFile(join(dir, `r${n + 1}`, "run.json"), JSON.stringify({ ids: ["c"] }));
    }
    return dir;
  };

  it("words no change by what the runs could detect, and lists the claims that moved", async () => {
    const r = (found: boolean[], recall: number) => golden(found, "h1", recall);
    const baseline = await repeated([
      r([true, false], 2 / 18),
      r([true, false], 3 / 18),
      r([false, false], 3 / 18),
    ]);
    const change = await repeated([
      r([true, true], 2 / 18),
      r([true, false], 2 / 18),
      r([true, false], 3 / 18),
    ]);
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    expect(await main(["compare", baseline, change], out, out)).toBe(0);
    expect(text).toContain("| Golden recall | 14.8% | 13.0% | -1.9% |");
    expect(text).toMatch(/\| Golden recall .* no change within noise \(detectable ≥ 9\.\d%\) \|/);
    expect(text).toContain(
      "2 found more often by the run, 0 less often, 0 as often; two-sided p = 0.500: no change",
    );
    expect(text).toContain("| c#1 | claim 1 \\| x | 2/3 | 3/3 |");
    expect(text).toContain("| c#2 | claim 2 \\| x | 0/3 | 1/3 |");
  });
});
