// What the nightly live smoke expects of its report (scripts/live-smoke-check.mjs).

/**
 * @typedef {object} SmokeReport
 * @property {unknown} [version]
 * @property {{ taskId?: string, status?: string, error?: string }[]} [tasks]
 * @property {{ fingerprint?: string, provenance?: { model?: string } }[]} [findings]
 * @property {{ costUsd?: number, inputTokens?: number, outputTokens?: number }} usage
 * @property {string} [verdict]
 * @property {string} [runId]
 */

/**
 * Everything wrong with a review on the free model: an unknown report
 * version, no task or one that did not complete, a cost, no tokens, or a
 * finding from another model than router/<model>.
 * @param {SmokeReport} report
 * @param {string} model
 */
export function smokeProblems(report, model) {
  /** @type {string[]} */
  const problems = [];
  if (report.version !== 1) problems.push(`report version ${report.version}`);
  const tasks = report.tasks ?? [];
  if (tasks.length === 0) problems.push("no review task ran");
  for (const t of tasks) {
    if (t.status !== "completed") problems.push(`task ${t.taskId} ${t.status}: ${t.error ?? ""}`);
  }
  if (report.usage.costUsd !== 0) {
    problems.push(`cost $${report.usage.costUsd}, expected $0 on the free model`);
  }
  if (report.usage.inputTokens === 0) problems.push("no tokens reported");
  const expected = `router/${model}`;
  for (const f of report.findings ?? []) {
    if (f.provenance?.model !== expected) {
      problems.push(`finding ${f.fingerprint} from ${f.provenance?.model}`);
    }
  }
  return problems;
}

/**
 * The run in one line, for the log.
 * @param {SmokeReport} report
 */
export function smokeLine(report) {
  const { usage } = report;
  return `${(report.tasks ?? []).length} task(s), ${(report.findings ?? []).length} finding(s), verdict ${report.verdict}, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, run ${report.runId ?? "n/a"}`;
}
