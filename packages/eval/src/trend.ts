import { formatValue } from "./compare.js";
import { countFunnel, FUNNEL_STAGES, type Funnel } from "./funnel.js";
import type { GoldenCaseScore } from "./golden-score.js";

// Many golden runs over time, grouped by series: how much the same setup
// varies from run to run, and how two setups differ. Runs are often partial
// (a cycle the quota stopped, cases that failed) and case sets change, so
// every number here is computed on the cases common to the runs it covers.

export interface TrendRun {
  // The label the run was made under (run.json), not the directory name.
  runId: string;
  dir: string;
  createdAt?: string | undefined;
  commit?: string | undefined;
  judge?: string | undefined;
  casesHash?: string | undefined;
  // Golden recall and precision over all the cases the run reviewed.
  overall: { recall: number; precision: number };
  // Undefined when the summary predates per-case scores.
  cases?: Record<string, GoldenCaseScore> | undefined;
  // By case: the wrap-up turns of its review tasks and the findings they
  // reported, from the reports' tasks[].wrapUp.
  wrapUps: Record<string, WrapUps>;
}

export interface WrapUps {
  turns: number;
  findings: number;
}

export interface Stats {
  n: number;
  mean: number;
  // Sample standard deviation; undefined for one run.
  sd?: number;
  min: number;
  max: number;
}

interface Scored {
  recall?: number;
  precision?: number;
  wrapUps: WrapUps;
  funnel: Funnel;
}

interface SeriesTrend {
  name: string;
  runs: (TrendRun & { scored?: Scored })[];
  // Cases every run with per-case scores reviewed, and every case any did.
  common: string[];
  seen: string[];
  recall?: Stats;
  precision?: Stats;
  wrapUps?: { turns: number; findings: number };
}

export interface Trend {
  series: SeriesTrend[];
  // Every series again, on the cases common to all of them.
  across?: { common: string[]; rows: { name: string; scored: Scored[] }[] };
  claims: {
    id: string;
    concern: string;
    hits: Record<string, { hits: number; runs: number }>;
    // Over every scored run of every series: a claim found always or never
    // tells two setups apart less than one found about half the time.
    stability: { hits: number; runs: number };
    // By series: how far the runs that missed it got (the funnel stage;
    // underrated: reported below its minimum severity).
    misses: Record<string, Record<string, number>>;
  }[];
  warnings: string[];
}

// A run's series is its label without the cycle number (and repetition):
// free-<model>@<ref>-smoke-3 and free-<model>@<ref>-smoke-4 are one series.
export function seriesOf(runId: string): string {
  return runId.replace(/\/r\d+$/, "").replace(/-\d+$/, "");
}

export function buildTrend(all: readonly TrendRun[], only?: readonly string[]): Trend {
  const warnings: string[] = [];
  const runs = dedupe(all, warnings).filter((r) => !only || only.includes(seriesOf(r.runId)));
  const names = [...new Set(runs.map((r) => seriesOf(r.runId)))].sort();
  const series = names.map((name) => {
    const members = runs
      .filter((r) => seriesOf(r.runId) === name)
      .sort((a, b) => a.runId.localeCompare(b.runId, "en", { numeric: true }));
    return seriesTrend(name, members, warnings);
  });
  const usable = series.flatMap((s) => s.runs.filter(hasCases));
  const common = commonCases(usable);
  const trend: Trend = { series, claims: claims(series, common), warnings };
  if (series.filter((s) => s.runs.some(hasCases)).length > 1) {
    trend.across = {
      common,
      rows: series
        .filter((s) => s.runs.some(hasCases))
        .map((s) => ({
          name: s.name,
          scored: s.runs.filter(hasCases).map((r) => score(r, common)),
        })),
    };
  }
  return trend;
}

function seriesTrend(name: string, runs: TrendRun[], warnings: string[]): SeriesTrend {
  const usable = runs.filter(hasCases);
  for (const r of runs.filter((r) => !hasCases(r))) {
    warnings.push(
      `${r.runId} has no per-case scores and is left out of the numbers; rescore it with ocra-eval score ${r.dir}`,
    );
  }
  const differ = (pick: (r: TrendRun) => unknown) => new Set(usable.map(pick)).size > 1;
  if (differ((r) => r.judge)) warnings.push(`${name}: the runs were scored by different judges`);
  if (differ((r) => r.casesHash)) {
    warnings.push(
      `${name}: the runs were scored against different golden cases or labels; rescore them`,
    );
  }
  const common = commonCases(usable);
  const seen = [...new Set(usable.flatMap((r) => Object.keys(r.cases)))].sort();
  const scoredRuns = runs.map((r) => (hasCases(r) ? { ...r, scored: score(r, common) } : r));
  const scored = scoredRuns.flatMap((r) => ("scored" in r && r.scored ? [r.scored] : []));
  const result: SeriesTrend = { name, runs: scoredRuns, common, seen };
  const recall = stats(scored.flatMap((s) => (s.recall === undefined ? [] : [s.recall])));
  const precision = stats(scored.flatMap((s) => (s.precision === undefined ? [] : [s.precision])));
  if (recall) result.recall = recall;
  if (precision) result.precision = precision;
  if (scored.length > 0) result.wrapUps = meanWrapUps(scored);
  return result;
}

function hasCases(run: TrendRun): run is TrendRun & { cases: Record<string, GoldenCaseScore> } {
  return run.cases !== undefined && Object.keys(run.cases).length > 0;
}

// The same run read twice (a cycle downloaded from two workflow runs): the
// copy with the most cases counts, then the newer one.
function dedupe(runs: readonly TrendRun[], warnings: string[]): TrendRun[] {
  const kept = new Map<string, TrendRun>();
  const size = (r: TrendRun) => Object.keys(r.cases ?? {}).length;
  for (const run of runs) {
    const other = kept.get(run.runId);
    if (!other) {
      kept.set(run.runId, run);
      continue;
    }
    const better =
      size(run) !== size(other)
        ? size(run) > size(other)
        : (run.createdAt ?? "") > (other.createdAt ?? "");
    const [keep, drop] = better ? [run, other] : [other, run];
    kept.set(run.runId, keep);
    warnings.push(`${run.runId} was found twice; ${keep.dir} counts, not ${drop.dir}`);
  }
  return [...kept.values()];
}

function commonCases(runs: readonly (TrendRun & { cases: Record<string, GoldenCaseScore> })[]) {
  const [first, ...rest] = runs;
  if (!first) return [];
  return Object.keys(first.cases)
    .filter((id) => rest.every((r) => id in r.cases))
    .sort();
}

function score(run: TrendRun & { cases: Record<string, GoldenCaseScore> }, ids: string[]): Scored {
  const sum = (pick: (c: GoldenCaseScore) => number) =>
    ids.reduce((total, id) => total + (run.cases[id] ? pick(run.cases[id]) : 0), 0);
  const expected = sum((c) => c.expected);
  const reported = sum((c) => c.reported);
  const scored: Scored = {
    wrapUps: {
      turns: ids.reduce((t, id) => t + (run.wrapUps[id]?.turns ?? 0), 0),
      findings: ids.reduce((t, id) => t + (run.wrapUps[id]?.findings ?? 0), 0),
    },
    funnel: countFunnel(ids.flatMap((id) => run.cases[id]?.claims ?? [])),
  };
  if (expected > 0) scored.recall = sum((c) => c.found) / expected;
  if (reported > 0) scored.precision = sum((c) => c.right) / reported;
  return scored;
}

export function stats(values: readonly number[]): Stats | undefined {
  const n = values.length;
  if (n === 0) return undefined;
  const mean = values.reduce((s, v) => s + v, 0) / n;
  const result: Stats = { n, mean, min: Math.min(...values), max: Math.max(...values) };
  if (n > 1) result.sd = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1));
  return result;
}

function meanWrapUps(scored: readonly Scored[]): WrapUps {
  const mean = (pick: (w: WrapUps) => number) =>
    scored.reduce((s, x) => s + pick(x.wrapUps), 0) / scored.length;
  return { turns: mean((w) => w.turns), findings: mean((w) => w.findings) };
}

// Each expected finding of the common cases, and how many runs of each
// series found it.
function claims(series: readonly SeriesTrend[], common: readonly string[]): Trend["claims"] {
  const rows: Trend["claims"] = [];
  for (const id of common) {
    const sample = series.flatMap((s) => s.runs.filter(hasCases))[0]?.cases?.[id];
    for (const [k, claim] of (sample?.claims ?? []).entries()) {
      const hits: Trend["claims"][number]["hits"] = {};
      const stability = { hits: 0, runs: 0 };
      const misses: Trend["claims"][number]["misses"] = {};
      for (const s of series) {
        const runs = s.runs.filter(hasCases);
        if (runs.length === 0) continue;
        const outcomes = runs.map((r) => r.cases[id]?.claims[k]);
        const found = outcomes.filter((c) => c?.found === true).length;
        hits[s.name] = { hits: found, runs: runs.length };
        stability.hits += found;
        stability.runs += runs.length;
        const missed: Record<string, number> = {};
        for (const c of outcomes.filter((c) => c?.found !== true)) {
          const stage = c?.stage === "found" ? "underrated" : (c?.stage ?? "unknown");
          missed[stage] = (missed[stage] ?? 0) + 1;
        }
        misses[s.name] = missed;
      }
      rows.push({ id: `${id}#${k + 1}`, concern: claim.concern, hits, stability, misses });
    }
  }
  return rows;
}

const pct = (v: number | undefined) => (v === undefined ? "–" : formatValue(v, true));
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function spread(s: Stats | undefined): string {
  if (!s) return "–";
  if (s.sd === undefined) return `${pct(s.mean)} (one run)`;
  return `${pct(s.mean)} (SD ${pct(s.sd)}; ${pct(s.min)} to ${pct(s.max)})`;
}

export function renderTrend(trend: Trend): string {
  const lines: string[] = ["# Golden trend", ""];
  for (const s of trend.series) {
    const only = s.seen.filter((id) => !s.common.includes(id));
    lines.push(
      `## ${s.name}`,
      "",
      s.seen.length === 0
        ? `${s.runs.length} run(s), none with per-case scores.`
        : `${s.runs.length} run(s); compared on ${s.common.length} case(s) every scored run reviewed${only.length > 0 ? ` (left out, reviewed by only some: ${only.join(", ")})` : ""}.`,
      "",
      "| Run | Commit | Cases | Golden recall | Golden precision | Wrap-up turns | Wrap-up findings | Funnel (not looked/looked/raised/dropped/found) | All its cases (recall, precision) |",
      "|---|---|---|---|---|---|---|---|---|",
      ...s.runs.map((r) => {
        const sc = "scored" in r ? r.scored : undefined;
        const cases = Object.keys(r.cases ?? {}).length;
        return `| ${r.runId} | ${r.commit?.slice(0, 12) ?? "–"} | ${cases} | ${pct(sc?.recall)} | ${pct(sc?.precision)} | ${sc ? sc.wrapUps.turns : "–"} | ${sc ? sc.wrapUps.findings : "–"} | ${sc ? funnelCell(sc.funnel) : "–"} | ${pct(r.overall.recall)}, ${pct(r.overall.precision)} |`;
      }),
      "",
      `- Golden recall: ${spread(s.recall)}`,
      `- Golden precision: ${spread(s.precision)}`,
      ...(s.wrapUps
        ? [
            `- Per run: ${num(s.wrapUps.turns)} wrap-up turn(s), ${num(s.wrapUps.findings)} finding(s) reported in them`,
          ]
        : []),
      ...judges(s),
      "",
    );
  }
  if (trend.across) {
    lines.push(
      `## Across series, on the ${trend.across.common.length} case(s) every scored run reviewed`,
      "",
      "| Series | Runs | Golden recall | Golden precision | Wrap-up turns per run | Wrap-up findings per run |",
      "|---|---|---|---|---|---|",
      ...trend.across.rows.map((row) => {
        const recall = stats(row.scored.flatMap((x) => (x.recall === undefined ? [] : [x.recall])));
        const precision = stats(
          row.scored.flatMap((x) => (x.precision === undefined ? [] : [x.precision])),
        );
        const w = meanWrapUps(row.scored);
        return `| ${row.name} | ${row.scored.length} | ${spread(recall)} | ${spread(precision)} | ${num(w.turns)} | ${num(w.findings)} |`;
      }),
      "",
    );
  }
  if (trend.claims.length > 0) {
    const names = trend.series.filter((s) => s.runs.some(hasCases)).map((s) => s.name);
    lines.push(
      "## Claims: runs that found each expected finding",
      "",
      "Stability is the share of all these runs that found it.",
      "",
      `| Claim | Concern | ${names.join(" | ")} | Stability |`,
      `|---|---|${names.map(() => "---|").join("")}---|`,
      ...trend.claims.map((c) => {
        const cells = names.map((n) => {
          const h = c.hits[n];
          return h ? `${h.hits}/${h.runs}${missesOf(c.misses[n] ?? {})}` : "–";
        });
        return `| ${c.id} | ${concernCell(c.concern)} | ${cells.join(" | ")} | ${pct(c.stability.hits / c.stability.runs)} |`;
      }),
      "",
    );
  }
  lines.push(...trend.warnings.map((w) => `Warning: ${w}\n`));
  return `${lines.join("\n")}\n`;
}

// Unknown alone when no review of the run kept a session log.
function funnelCell(funnel: Funnel): string {
  const known = FUNNEL_STAGES.map((stage) => funnel[stage]);
  if (known.every((n) => n === 0)) return funnel.unknown > 0 ? "unknown" : "–";
  return `${known.join("/")}${funnel.unknown > 0 ? `, ${funnel.unknown} unknown` : ""}`;
}

const MISS_ORDER = ["not-looked", "looked", "raised", "dropped", "underrated", "unknown"];

// Nothing when no run that missed it kept a session log.
function missesOf(misses: Record<string, number>): string {
  if (Object.keys(misses).every((stage) => stage === "unknown")) return "";
  const parts = MISS_ORDER.flatMap((stage) => (misses[stage] ? [`${stage} ${misses[stage]}`] : []));
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function judges(s: SeriesTrend): string[] {
  const all = [...new Set(s.runs.flatMap((r) => (r.judge ? [r.judge] : [])))];
  return all.length > 0 ? [`- Judge: ${all.join("; ")}`] : [];
}

// Concerns are case text: one line, bounded, and no table breaks.
export function concernCell(text: string): string {
  const line = text.replace(/\s+/g, " ").replaceAll("|", "\\|").trim();
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}
