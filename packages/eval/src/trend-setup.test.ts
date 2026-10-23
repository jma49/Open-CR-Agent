import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProvenanceSummary } from "./provenance.js";
import { buildTrend } from "./trend.js";
import { loadTrendRuns } from "./trend-load.js";

const build = (commit: string) => ({ version: "0.7.0", commit, maxAgentSteps: 30 });
const made = (commits: string[]): ProvenanceSummary => ({
  ocraVersion: ["0.7.0"],
  promptHash: ["p1"],
  configHash: ["c1"],
  sampling: [{}],
  ocra: commits.map(build),
  runtime: ["opencode"],
});

async function writeRun(root: string, runId: string, provenance?: unknown): Promise<void> {
  const dir = join(root, runId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "run.json"), JSON.stringify({ version: 1, ids: ["a"] }));
  const golden = {
    recall: 0.5,
    precision: 0.5,
    casesHash: "h1",
    cases: {
      a: {
        expected: 1,
        found: 1,
        reported: 1,
        right: 1,
        claims: [{ id: "x", concern: "x", found: true }],
      },
    },
  };
  await writeFile(
    join(dir, "summary.json"),
    JSON.stringify({
      version: 1,
      info: { runId, judge: "j" },
      summary: { golden, ...(provenance ? { provenance } : {}) },
    }),
  );
}

describe("trend over setups", () => {
  it("names a run that mixes setups, and a series whose runs differ", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocra-trend-setup-"));
    await writeRun(root, "nightly-1", made(["a".repeat(40)]));
    await writeRun(root, "nightly-2", made(["a".repeat(40), "b".repeat(40)]));
    await writeRun(root, "steady-1", made(["a".repeat(40)]));
    await writeRun(root, "steady-2", made(["a".repeat(40)]));
    const { runs, notes } = await loadTrendRuns(root);
    expect(notes).toEqual([]);
    expect(buildTrend(runs).warnings).toEqual([
      "nightly-2: its reviews were made with different ocra builds: 0.7.0 at aaaaaaaaaaaa, 30 steps per review agent vs 0.7.0 at bbbbbbbbbbbb, 30 steps per review agent",
      "nightly: the runs were made with different ocra builds: 0.7.0 at aaaaaaaaaaaa, 30 steps per review agent vs 0.7.0 at aaaaaaaaaaaa, 30 steps per review agent + 0.7.0 at bbbbbbbbbbbb, 30 steps per review agent",
    ]);
  });

  it("skips a summary in a format it does not know", async () => {
    const root = await mkdtemp(join(tmpdir(), "ocra-trend-setup-"));
    await writeRun(root, "later-1");
    const path = join(root, "later-1", "summary.json");
    await writeFile(path, JSON.stringify({ version: 2, info: { runId: "later-1" }, summary: {} }));
    const { runs, notes } = await loadTrendRuns(root);
    expect(runs).toEqual([]);
    expect(notes).toEqual([
      `later-1: ${path} has format version 2; this ocra-eval reads version 1, so read it with the ocra-eval that wrote it`,
    ]);
  });
});
