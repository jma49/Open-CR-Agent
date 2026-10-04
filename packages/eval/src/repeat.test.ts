import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { compareSummaries, type SavedSummary } from "./compare.js";
import {
  loadRuns,
  REPEATS_FILE,
  renderRepeats,
  repeatRuns,
  repetitionDir,
  summarizeRepeats,
} from "./repeat.js";

function saved(precision: number, recall = 0.5, cost = 1, promptHash = "p1"): SavedSummary {
  return {
    summary: {
      overall: { metrics: { precision, recall, f1: 0.5 } },
      costPerReviewedUsd: cost,
      durationSeconds: { median: 60 },
      usage: { costUsd: cost },
      provenance: {
        ocraVersion: ["0.3.0"],
        promptHash: [promptHash],
        configHash: ["c1"],
        sampling: [{ temperature: 0 }],
      },
    },
  } as unknown as SavedSummary;
}

describe("repeatRuns", () => {
  it("runs k times into r1 … rk, each with what the earlier ones left of the budget", async () => {
    const calls: { dir: string; n: number; left: number | undefined }[] = [];
    const logs: string[] = [];
    const runs = await repeatRuns("/runs/x", 3, 2.5, logs.push.bind(logs), async (dir, n, left) => {
      calls.push({ dir, n, left });
      return saved(0.3, 0.5, 1);
    });
    expect(calls).toEqual([
      { dir: repetitionDir("/runs/x", 1), n: 1, left: 2.5 },
      { dir: repetitionDir("/runs/x", 2), n: 2, left: 1.5 },
      { dir: repetitionDir("/runs/x", 3), n: 3, left: 0.5 },
    ]);
    expect(runs.map((r) => r.name)).toEqual(["r1", "r2", "r3"]);
    expect(logs).toEqual(["repetition 1 of 3", "repetition 2 of 3", "repetition 3 of 3"]);
  });

  it("gives later repetitions nothing once the budget is spent, and no limit without one", async () => {
    const lefts: (number | undefined)[] = [];
    const run = (max: number | undefined) =>
      repeatRuns(
        "/r",
        2,
        max,
        () => {},
        async (_dir, _n, left) => {
          lefts.push(left);
          return saved(0.3, 0.5, 5);
        },
      );
    await run(1);
    await run(undefined);
    expect(lefts).toEqual([1, 0, undefined, undefined]);
  });
});

describe("summarizeRepeats", () => {
  it("reports each metric's runs and the 95% interval of their mean", () => {
    const runs = [0.3, 0.4, 0.5].map((p, i) => ({ name: `r${i + 1}`, saved: saved(p) }));
    const summary = summarizeRepeats(runs);
    expect(summary.repeat).toBe(3);
    expect(summary.runs).toEqual(["r1", "r2", "r3"]);
    expect(summary.metrics.Precision?.values).toEqual([0.3, 0.4, 0.5]);
    expect(summary.metrics.Precision?.interval?.low).toBeCloseTo(
      0.4 - (4.303 * 0.1) / Math.sqrt(3),
    );
    expect(summary.metrics.Recall?.interval).toMatchObject({ low: 0.5, high: 0.5 });
    // Golden metrics are absent from a benchmark run.
    expect(summary.metrics).not.toHaveProperty("Golden precision");
    const text = renderRepeats("x", summary, runs[0]?.saved);
    expect(text).toContain("| Precision | 40.0% | 15.2% to 64.8% | 30.0%, 40.0%, 50.0% |");
    expect(text).toContain("sampling temperature 0");
  });
});

describe("comparing repeated runs", () => {
  it("calls a change only when the intervals separate", () => {
    const side = (...ps: number[]) => ps.map((p) => saved(p));
    const rows = compareSummaries(side(0.3, 0.31, 0.32), side(0.4, 0.41, 0.42));
    expect(rows.find((r) => r.metric === "Precision")).toMatchObject({
      verdict: "better",
      baseline: expect.closeTo(0.31, 10),
      run: expect.closeTo(0.41, 10),
    });
    // The same means, but runs too far apart to tell.
    const noisy = compareSummaries(side(0.1, 0.31, 0.52), side(0.2, 0.41, 0.62));
    expect(noisy.find((r) => r.metric === "Precision")?.verdict).toBe("no change");
    // A metric without an interval is not judged without a second baseline.
    expect(rows.find((r) => r.metric === "Cost per reviewed PR ($)")?.verdict).toBe("unknown");
  });

  it("reads repeated run directories from the command line", async () => {
    const repeated = async (precisions: number[], promptHash: string) => {
      const dir = await mkdtemp(join(tmpdir(), "ocra-repeat-"));
      const names = precisions.map((_, i) => `r${i + 1}`);
      for (const [i, p] of precisions.entries()) {
        const sub = join(dir, names[i] as string);
        await mkdir(sub);
        await writeFile(join(sub, "summary.json"), JSON.stringify(saved(p, 0.5, 1, promptHash)));
        await writeFile(join(sub, "run.json"), JSON.stringify({ ids: ["a"] }));
      }
      await writeFile(
        join(dir, REPEATS_FILE),
        JSON.stringify({ repeat: names.length, runs: names }),
      );
      return dir;
    };
    const baseline = await repeated([0.3, 0.31, 0.32], "p1");
    expect((await loadRuns(baseline)).summaries).toHaveLength(3);

    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    const code = await main(
      ["compare", baseline, await repeated([0.4, 0.41, 0.42], "p2")],
      out,
      out,
    );
    expect(code).toBe(0);
    expect(text).toContain("| 95% CI, baseline | 95% CI, run |");
    expect(text).toMatch(
      /\| Precision \| 31\.0% \| 41\.0% \| \+10\.0% \| not measured \| .+ \| .+ \| better \|/,
    );
    expect(text).toContain(
      'Warning: the runs were made with different prompts (promptHash): ["p1"] vs ["p2"]',
    );
  });

  it("refuses a repeats file that names a path outside the run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-repeat-"));
    await writeFile(join(dir, REPEATS_FILE), JSON.stringify({ repeat: 1, runs: ["../x"] }));
    await expect(loadRuns(dir)).rejects.toThrow(/invalid run/);
  });
});
