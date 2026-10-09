import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import type { GoldenCaseScore } from "./golden-score.js";
import { buildTrend, seriesOf, stats } from "./trend.js";
import { loadTrendRuns } from "./trend-load.js";

// A case with two expected findings; `hits` says which were found.
const kase = (hits: [boolean, boolean], reported: number, right: number): GoldenCaseScore => ({
  expected: 2,
  found: hits.filter(Boolean).length,
  reported,
  right,
  claims: [
    { concern: "first | issue", found: hits[0] },
    { concern: "second issue", found: hits[1] },
  ],
});

interface Fixture {
  runId: string;
  cases?: Record<string, GoldenCaseScore>;
  // Per case: the findings each wrap-up turn of its tasks reported.
  wrapUps?: Record<string, number[]>;
  createdAt?: string;
}

async function writeRun(dir: string, f: Fixture): Promise<void> {
  await mkdir(join(dir, "reports"), { recursive: true });
  const golden = {
    recall: 0.5,
    precision: 0.5,
    casesHash: "h1",
    ...(f.cases ? { cases: f.cases } : {}),
  };
  await writeFile(join(dir, "run.json"), JSON.stringify({ ids: Object.keys(f.cases ?? {}) }));
  await writeFile(
    join(dir, "summary.json"),
    JSON.stringify({
      info: {
        runId: f.runId,
        createdAt: f.createdAt ?? "2026-10-05T00:00:00Z",
        judge: "openai-compatible stealth/m",
        ocra: { version: "0.6.0", commit: "0123456789abcdef", maxAgentSteps: 30 },
      },
      summary: { golden },
    }),
  );
  for (const [id, findings] of Object.entries(f.wrapUps ?? {})) {
    const tasks = [
      { taskId: "t0" },
      ...findings.map((n) => ({ taskId: "t", wrapUp: { findings: n } })),
    ];
    await writeFile(join(dir, "reports", `${id}.json`), JSON.stringify({ tasks }));
  }
}

async function fixtures(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ocra-trend-"));
  // The cache layout: run directories side by side.
  await writeRun(join(root, "free-m@main-smoke-1"), {
    runId: "free-m@main-smoke-1",
    cases: {
      a: kase([true, false], 4, 2),
      b: kase([true, true], 2, 2),
      c: kase([false, false], 1, 0),
    },
  });
  // A partial cycle: case c not reviewed yet.
  await writeRun(join(root, "free-m@main-smoke-2"), {
    runId: "free-m@main-smoke-2",
    cases: { a: kase([false, false], 2, 0), b: kase([true, true], 2, 1) },
  });
  // Downloaded artifacts: one directory per artifact, named with the workflow run.
  await writeRun(join(root, "downloads", "free-m@feat-x-smoke-1-123"), {
    runId: "free-m@feat-x-smoke-1",
    cases: {
      a: kase([true, true], 3, 3),
      b: kase([true, false], 2, 1),
      c: kase([true, false], 2, 1),
    },
    wrapUps: { a: [2, 0], b: [1], c: [5] },
  });
  // An older summary without per-case scores, and a run never scored.
  await writeRun(join(root, "free-smoke-4"), { runId: "free-smoke-4" });
  await mkdir(join(root, "unscored"));
  await writeFile(join(root, "unscored", "run.json"), JSON.stringify({ ids: [] }));
  return root;
}

describe("trend", () => {
  it("groups runs into series by label without the cycle number", () => {
    expect(seriesOf("free-m@main-smoke-12")).toBe("free-m@main-smoke");
    expect(seriesOf("baseline/r2")).toBe("baseline");
    expect(seriesOf("baseline")).toBe("baseline");
  });

  it("computes mean and spread", () => {
    expect(stats([])).toBeUndefined();
    expect(stats([0.5])).toEqual({ n: 1, mean: 0.5, min: 0.5, max: 0.5 });
    const s = stats([0.2, 0.4]);
    expect(s?.mean).toBeCloseTo(0.3);
    expect(s?.sd).toBeCloseTo(Math.SQRT2 * 0.1);
  });

  it("compares a series only on the cases all its runs reviewed", async () => {
    const { runs, notes } = await loadTrendRuns(await fixtures());
    expect(notes).toEqual(["unscored: not scored yet (no summary.json)"]);
    const trend = buildTrend(runs);
    const main = trend.series.find((s) => s.name === "free-m@main-smoke");
    expect(main?.common).toEqual(["a", "b"]);
    expect(main?.seen).toEqual(["a", "b", "c"]);
    // Run 1 on a and b: 3 of 4 found, 4 of 6 reported right; run 2: 2 of 4, 1 of 4.
    const scored = main?.runs.map((r) => ("scored" in r ? r.scored : undefined));
    expect(scored?.[0]).toMatchObject({ recall: 0.75 });
    expect(scored?.[0]?.precision).toBeCloseTo(4 / 6);
    expect(scored?.[1]).toMatchObject({ recall: 0.5, precision: 0.25 });
    expect(main?.recall?.mean).toBeCloseTo(0.625);
    expect(main?.recall?.n).toBe(2);
  });

  it("compares series on the cases common to every run, with wrap-up turns and claim hits", async () => {
    const trend = buildTrend((await loadTrendRuns(await fixtures())).runs);
    expect(trend.across?.common).toEqual(["a", "b"]);
    const feat = trend.across?.rows.find((r) => r.name === "free-m@feat-x-smoke");
    // Case c is not common, so its wrap-up turn is left out.
    expect(feat?.scored).toEqual([
      { recall: 0.75, precision: 0.8, wrapUps: { turns: 3, findings: 3 } },
    ]);
    expect(trend.claims.map((c) => [c.id, c.hits])).toEqual([
      [
        "a#1",
        { "free-m@feat-x-smoke": { hits: 1, runs: 1 }, "free-m@main-smoke": { hits: 1, runs: 2 } },
      ],
      [
        "a#2",
        { "free-m@feat-x-smoke": { hits: 1, runs: 1 }, "free-m@main-smoke": { hits: 0, runs: 2 } },
      ],
      [
        "b#1",
        { "free-m@feat-x-smoke": { hits: 1, runs: 1 }, "free-m@main-smoke": { hits: 2, runs: 2 } },
      ],
      [
        "b#2",
        { "free-m@feat-x-smoke": { hits: 0, runs: 1 }, "free-m@main-smoke": { hits: 2, runs: 2 } },
      ],
    ]);
    expect(trend.claims.map((c) => c.stability)).toEqual([
      { hits: 2, runs: 3 },
      { hits: 1, runs: 3 },
      { hits: 3, runs: 3 },
      { hits: 2, runs: 3 },
    ]);
    expect(trend.warnings.join("\n")).toContain("free-smoke-4 has no per-case scores");
  });

  it("restricts to the series asked for", async () => {
    const trend = buildTrend((await loadTrendRuns(await fixtures())).runs, ["free-m@main-smoke"]);
    expect(trend.series.map((s) => s.name)).toEqual(["free-m@main-smoke"]);
    expect(trend.across).toBeUndefined();
    expect(trend.claims).toHaveLength(4);
  });

  it("counts a run read twice once, keeping the copy with more cases", async () => {
    const root = await fixtures();
    await writeRun(join(root, "downloads", "free-m@main-smoke-2-99"), {
      runId: "free-m@main-smoke-2",
      cases: { a: kase([true, true], 1, 1) },
    });
    const trend = buildTrend((await loadTrendRuns(root)).runs);
    const main = trend.series.find((s) => s.name === "free-m@main-smoke");
    expect(main?.runs).toHaveLength(2);
    expect(main?.common).toEqual(["a", "b"]);
    expect(trend.warnings.join("\n")).toMatch(
      /free-m@main-smoke-2 was found twice; .*smoke-2 counts/,
    );
  });

  it("prints the trend as Markdown", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(
      ["trend", await fixtures()],
      { write: (s: string) => out.push(s) },
      { write: (s: string) => err.push(s) },
    );
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("## free-m@main-smoke");
    expect(text).toContain(
      "compared on 2 case(s) every scored run reviewed (left out, reviewed by only some: c)",
    );
    expect(text).toContain(
      "| free-m@main-smoke-1 | 0123456789ab | 3 | 75.0% | 66.7% | 0 | 0 | 50.0%, 50.0% |",
    );
    expect(text).toContain("- Golden recall: 62.5% (SD 17.7%; 50.0% to 75.0%)");
    expect(text).toContain("## Across series, on the 2 case(s) every scored run reviewed");
    expect(text).toContain("| a#1 | first \\| issue | 1/1 | 1/2 |");
    expect(err.join("")).toContain("skipped unscored: not scored yet");
  });

  it("fails when there is no golden run", async () => {
    const err: string[] = [];
    const code = await main(
      ["trend", await mkdtemp(join(tmpdir(), "ocra-trend-"))],
      { write: () => undefined },
      { write: (s: string) => err.push(s) },
    );
    expect(code).toBe(2);
    expect(err.join("")).toContain("no golden runs under");
  });
});
