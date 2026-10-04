// CI's recall-ceiling gate: compares `ocra-eval ceiling --dataset golden`
// (ceiling.json) with the committed baseline and fails when the
// deterministic stages reach fewer expected findings than they did.
//
//   node scripts/ceiling-gate.mjs <ceiling.json> [baseline.json]
//   node scripts/ceiling-gate.mjs <ceiling.json> [baseline.json] --write
//
// --write records the measurement as the new baseline; do that in the pull
// request that changes the golden cases or raises the ceiling.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASELINE = "evals/ceiling-baseline.json";

/**
 * What `ocra-eval ceiling` writes (ceiling.json), as far as the gate reads it.
 * @typedef {object} Ceiling
 * @property {{ instances: number, references: number, byReach: { reachable: number } }} summary
 * @property {{ instance: string, path: string, reach: string }[]} reaches
 */

/**
 * The committed baseline: the summary counts and each reference's reach.
 * @typedef {object} Baseline
 * @property {number} instances
 * @property {number} references
 * @property {number} reachable
 * @property {Record<string, string>} reaches
 */

/**
 * @typedef {object} Comparison
 * @property {{ key: string, before: string, after: string }[]} changes
 * @property {string[]} problems
 * @property {boolean} improved
 */

// A reference has no id of its own; it is the n-th annotated issue on a path
// of a case, which is stable while the case file is.
/**
 * @param {Ceiling} ceiling
 * @returns {Baseline}
 */
export function baselineOf(ceiling) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  /** @type {Record<string, string>} */
  const reaches = {};
  for (const r of ceiling.reaches) {
    const prefix = `${r.instance} ${r.path}`;
    const n = seen.get(prefix) ?? 0;
    seen.set(prefix, n + 1);
    reaches[`${prefix} #${n + 1}`] = r.reach;
  }
  return {
    instances: ceiling.summary.instances,
    references: ceiling.summary.references,
    reachable: ceiling.summary.byReach.reachable,
    reaches: Object.fromEntries(Object.entries(reaches).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * @param {Baseline} baseline
 * @param {Baseline} current
 * @returns {Comparison}
 */
export function compareCeiling(baseline, current) {
  /** @type {Comparison["changes"]} */
  const changes = [];
  const keys = new Set([...Object.keys(baseline.reaches), ...Object.keys(current.reaches)]);
  for (const key of [...keys].sort()) {
    const before = baseline.reaches[key] ?? "absent";
    const after = current.reaches[key] ?? "absent";
    if (before !== after) changes.push({ key, before, after });
  }
  /** @type {string[]} */
  const problems = [];
  if (current.instances < baseline.instances) {
    problems.push(
      `${current.instances} case(s) classified, the baseline has ${baseline.instances}: a case failed (see the log)`,
    );
  }
  if (current.reachable < baseline.reachable) {
    problems.push(`${current.reachable} reachable, the baseline has ${baseline.reachable}`);
  }
  for (const c of changes) {
    if (c.before === "reachable") problems.push(`no longer reachable: ${c.key} (${c.after})`);
  }
  return { changes, problems, improved: problems.length === 0 && changes.length > 0 };
}

/**
 * @param {Baseline} baseline
 * @param {Baseline} current
 * @param {Comparison} result
 */
export function renderComparison(baseline, current, result) {
  const lines = [
    `Reachable: ${current.reachable} of ${current.references} in ${current.instances} case(s); baseline ${baseline.reachable} of ${baseline.references} in ${baseline.instances}.`,
  ];
  if (result.changes.length > 0) {
    lines.push("", "| Reference | Baseline | Now |", "|---|---|---|");
    for (const c of result.changes) lines.push(`| ${c.key} | ${c.before} | ${c.after} |`);
  }
  if (result.problems.length > 0) {
    lines.push("", "Regressions:", ...result.problems.map((p) => `- ${p}`));
  } else if (result.improved) {
    lines.push(
      "",
      `Changed without a regression: record it with \`node scripts/ceiling-gate.mjs <ceiling.json> --write\`.`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** @param {string[]} argv */
function main(argv) {
  const write = argv.includes("--write");
  const [ceilingPath, baselinePath = DEFAULT_BASELINE] = argv.filter((a) => a !== "--write");
  if (!ceilingPath) {
    process.stderr.write("usage: ceiling-gate.mjs <ceiling.json> [baseline.json] [--write]\n");
    return 2;
  }
  const current = baselineOf(JSON.parse(readFileSync(ceilingPath, "utf8")));
  if (write) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(`Wrote ${baselinePath}\n`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = compareCeiling(baseline, current);
  process.stdout.write(renderComparison(baseline, current, result));
  return result.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
