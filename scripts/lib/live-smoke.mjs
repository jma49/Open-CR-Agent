// What the nightly live smoke expects of its review (scripts/live-smoke-check.mjs).

const QUOTA = /429|quota|rate.?limit|free-models-per-day/i;

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
 * Everything wrong with the smoke's review, as GitHub error annotations; none
 * when it passed. A review in which no task completed is titled "Live smoke
 * reviewed nothing", a spent free quota included: that night is red, not
 * skipped, so green always means a model reviewed the change.
 * @param {SmokeReport | undefined} report undefined when ocra wrote none
 * @param {string} model the free model, without the router/ prefix
 * @param {string} exitCode ocra review's: 0 and 1 are reviews that finished
 *   (1: a confirmed critical, which a model may report); 2 is an error, 3 an
 *   incomplete review
 */
export function smokeErrors(report, model, exitCode) {
  const nothing = reviewedNothing(report);
  const problems = [
    ...(exitCode === "0" || exitCode === "1" ? [] : [`ocra review exited ${exitCode}`]),
    ...(report ? reviewProblems(report, model) : []),
  ];
  return [
    ...(nothing ? [annotation("Live smoke reviewed nothing", nothing)] : []),
    ...problems.map((p) => annotation("Live smoke failed", p)),
  ];
}

/**
 * Why no task completed, or undefined when one did.
 * @param {SmokeReport | undefined} report
 */
function reviewedNothing(report) {
  if (!report) return "ocra wrote no report";
  const tasks = report.tasks ?? [];
  if (tasks.some((t) => t.status === "completed")) return undefined;
  if (tasks.length === 0) return "no review task ran";
  if (tasks.every((t) => QUOTA.test(t.error ?? ""))) {
    return `the free model quota is spent: all ${tasks.length} task(s) failed on it; it resets at 00:00 UTC`;
  }
  return `none of the ${tasks.length} task(s) completed`;
}

/**
 * An unknown report version, a task that did not complete, a cost, no
 * tokens, or a finding from another model than router/<model>.
 * @param {SmokeReport} report
 * @param {string} model
 */
function reviewProblems(report, model) {
  /** @type {string[]} */
  const problems = [];
  if (report.version !== 1) problems.push(`report version ${report.version}`);
  for (const t of report.tasks ?? []) {
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
 * A workflow command ends at a line break: GitHub's escapes keep a provider's
 * multi-line error in one annotation, and its later lines from being read as
 * commands.
 * @param {string} title
 * @param {string} message
 */
function annotation(title, message) {
  const data = message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  return `::error title=${title}::${data}`;
}

/**
 * The run in one line, for the log.
 * @param {SmokeReport} report
 */
export function smokeLine(report) {
  const { usage } = report;
  return `${(report.tasks ?? []).length} task(s), ${(report.findings ?? []).length} finding(s), verdict ${report.verdict}, ${usage.inputTokens} in / ${usage.outputTokens} out tokens, run ${report.runId ?? "n/a"}`;
}
