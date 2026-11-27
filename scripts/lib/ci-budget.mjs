// CI's time budgets (scripts/ci-budget.mjs): each finished job of a run
// against its ceiling in the budgets file.

/**
 * A job as the Actions API lists it, as far as the budget reads it.
 * @typedef {object} Job
 * @property {string} name
 * @property {number} run_attempt
 * @property {string | null} conclusion
 * @property {string} created_at
 * @property {string | null} started_at
 * @property {string | null} completed_at
 * @property {{ name: string, started_at: string | null, completed_at: string | null }[]} [steps]
 */

/**
 * Ceilings in seconds, keyed by job name without its matrix suffix
 * ("node-matrix" for "node-matrix (24)"); "*" covers the rest.
 * @typedef {Record<string, number>} Ceilings
 * @typedef {{ setup: Ceilings, running: Ceilings }} Budgets
 */

/**
 * @typedef {object} Row
 * @property {string} name
 * @property {number} waiting
 * @property {number} setup
 * @property {number} running
 * @property {number} budget
 * @property {string[]} over
 */

// The steps that make the machine ready: the runner's own, the checkout and
// Node with the dependencies, through the setup action or `npm ci`.
const SETUP_STEP =
  /^(Set up job|Initialize containers|Run actions\/checkout|Run actions\/setup-node|Run \.\/\.github\/actions\/setup|Run npm ci\b)/;
const FINISHED = new Set(["success", "failure"]);

/** @param {string} run @param {string} token @param {typeof fetch} request */
export async function runJobs(run, token, request = fetch) {
  /** @type {Job[]} */
  const jobs = [];
  for (let page = 1; ; page++) {
    const url = `${run}/jobs?filter=all&per_page=100&page=${page}`;
    const response = await request(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    jobs.push(.../** @type {{ jobs: Job[] }} */ (await response.json()).jobs);
    if (!response.headers.get("link")?.includes('rel="next"')) return jobs;
  }
}

/** @param {Job} job */
const executionKey = (job) =>
  JSON.stringify([job.name, job.conclusion, job.started_at, job.completed_at]);

/** @param {readonly Job[]} jobs */
function latestExecutions(jobs) {
  /** @type {Map<string, number>} */
  const latest = new Map();
  /** @type {Map<string, Job>} */
  const originals = new Map();
  for (const job of jobs) {
    latest.set(job.name, Math.max(latest.get(job.name) ?? 0, job.run_attempt));
    if (job.started_at && job.created_at <= job.started_at) originals.set(executionKey(job), job);
  }
  return jobs
    .filter((job) => job.run_attempt === latest.get(job.name))
    .map((job) =>
      // A carried-forward job can be re-created with its original start and end.
      job.started_at && job.created_at > job.started_at
        ? (originals.get(executionKey(job)) ?? job)
        : job,
    );
}

/** @param {string | null} from @param {string | null} to */
const seconds = (from, to) => (from && to ? (Date.parse(to) - Date.parse(from)) / 1000 : 0);

/** @param {Ceilings} ceilings @param {string} name */
export function ceiling(ceilings, name) {
  const value = ceilings[name.replace(/ \(.*\)$/, "")] ?? ceilings["*"];
  if (value === undefined) throw new Error(`no ceiling for job "${name}" and no "*"`);
  return value;
}

/**
 * @param {readonly Job[]} jobs
 * @param {Budgets} budgets
 * @returns {Row[]}
 */
export function checkBudgets(jobs, budgets) {
  return latestExecutions(jobs)
    .filter((job) => job.conclusion !== null && FINISHED.has(job.conclusion))
    .map((job) => {
      const setup = (job.steps ?? [])
        .filter((step) => SETUP_STEP.test(step.name))
        .reduce((sum, step) => sum + seconds(step.started_at, step.completed_at), 0);
      // A slow cache restore is the runner's, and setup has its own ceiling.
      const running = seconds(job.started_at, job.completed_at) - setup;
      const setupBudget = ceiling(budgets.setup, job.name);
      const budget = ceiling(budgets.running, job.name);
      const over = [];
      if (setup > setupBudget) over.push(`setup ${setup} s > ${setupBudget} s`);
      if (running > budget) over.push(`running ${running} s > ${budget} s`);
      return {
        name: job.name,
        waiting: seconds(job.created_at, job.started_at),
        setup,
        running,
        budget,
        over,
      };
    });
}

/** @param {readonly Row[]} rows */
export function renderBudgets(rows) {
  const lines = [
    "| Job | Waiting | Setup | Running | Budget | |",
    "|---|---:|---:|---:|---:|---|",
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.waiting} s | ${r.setup} s | ${r.running} s | ${r.budget} s | ${r.over.length ? `over: ${r.over.join(", ")}` : "ok"} |`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}
