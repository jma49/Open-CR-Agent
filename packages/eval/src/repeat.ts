import { join } from "node:path";
import { formatInterval, formatValue, METRICS, type SavedSummary } from "./compare.js";
import { readJson } from "./golden.js";
import { confidenceInterval, type Interval } from "./interval.js";
import { renderProvenance } from "./provenance.js";

// A run made with --repeat k: k ordinary runs in r1/ … rk/ under the run
// directory, and this file beside them.
export const REPEATS_FILE = "repeats.json";

export function repetitionDir(runDir: string, n: number): string {
  return join(runDir, `r${n}`);
}

export interface Repetition {
  name: string;
  saved: SavedSummary;
}

// Runs the selection k times, one after another. --max-cost-usd bounds the
// repetitions together: each gets what the earlier ones left. A repetition
// that already finished is resumed like any run, at no new cost.
export async function repeatRuns(
  runDir: string,
  repeat: number,
  maxCostUsd: number | undefined,
  log: (message: string) => void,
  runOnce: (dir: string, n: number, maxCostUsd: number | undefined) => Promise<SavedSummary>,
): Promise<Repetition[]> {
  const runs: Repetition[] = [];
  let spent = 0;
  for (let n = 1; n <= repeat; n++) {
    log(`repetition ${n} of ${repeat}`);
    const left = maxCostUsd === undefined ? undefined : Math.max(0, maxCostUsd - spent);
    const saved = await runOnce(repetitionDir(runDir, n), n, left);
    spent += saved.summary.usage.costUsd;
    runs.push({ name: `r${n}`, saved });
  }
  return runs;
}

export interface RepeatSummary {
  repeat: number;
  runs: string[];
  // By metric name: each run's value, and the 95% interval of their mean.
  metrics: Record<string, { values: number[]; interval?: Interval }>;
}

export function summarizeRepeats(runs: readonly Repetition[]): RepeatSummary {
  const metrics: RepeatSummary["metrics"] = {};
  for (const metric of METRICS.filter((m) => m.interval)) {
    const values = runs.map((r) => metric.value(r.saved));
    if (values.some((v) => v === undefined)) continue;
    const numbers = values as number[];
    const interval = confidenceInterval(numbers);
    metrics[metric.name] = { values: numbers, ...(interval ? { interval } : {}) };
  }
  return { repeat: runs.length, runs: runs.map((r) => r.name), metrics };
}

export function renderRepeats(label: string, summary: RepeatSummary, first?: SavedSummary): string {
  const rows = Object.entries(summary.metrics).map(([name, m]) => {
    const mean = m.values.reduce((s, v) => s + v, 0) / m.values.length;
    return `| ${name} | ${formatValue(mean, true)} | ${m.interval ? formatInterval(m.interval, true) : "needs two runs"} | ${m.values.map((v) => formatValue(v, true)).join(", ")} |`;
  });
  return [
    `# Repeated run ${label} (${summary.repeat} runs)`,
    "",
    ...(first ? [`- Provenance: ${renderProvenance(first.summary.provenance)}`, ""] : []),
    "| Metric | Mean | 95% CI | Runs |",
    "|---|---|---|---|",
    ...rows,
    "",
    "The interval is a Student t interval over the runs' values: mean ± t(0.975, k−1) · s/√k. `ocra-eval compare` calls a change better or worse only when the two runs' intervals do not overlap. Each run's own summary is in its directory.",
    "",
  ].join("\n");
}

export async function readRepeats(runDir: string): Promise<RepeatSummary | undefined> {
  try {
    return (await readJson(join(runDir, REPEATS_FILE))) as RepeatSummary;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// A run directory's summaries: one, or one per repetition.
export async function loadRuns(dir: string): Promise<{ summaries: SavedSummary[]; ids: string[] }> {
  const repeats = await readRepeats(dir);
  const dirs = repeats ? repeats.runs.map((name) => join(dir, safeName(name))) : [dir];
  const summaries: SavedSummary[] = [];
  let ids: string[] = [];
  for (const [n, runDir] of dirs.entries()) {
    summaries.push((await readJson(join(runDir, "summary.json"))) as SavedSummary);
    if (n === 0) ids = ((await readJson(join(runDir, "run.json"))) as { ids: string[] }).ids;
  }
  return { summaries, ids };
}

// repeats.json is a file on disk like any other: its names become paths.
function safeName(name: string): string {
  if (!/^r\d+$/.test(name)) throw new Error(`${REPEATS_FILE} lists an invalid run "${name}"`);
  return name;
}
