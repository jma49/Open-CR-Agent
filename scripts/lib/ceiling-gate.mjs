// The recall-ceiling gate's comparison (scripts/ceiling-gate.mjs).

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
