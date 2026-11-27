// CI's time budgets: reads the jobs of this workflow run from the Actions
// API and fails when a finished job ran or set up longer than its ceiling in
// the budgets file. Waiting is reported, not judged: it depends on the
// runners, not on the repository. The last job of a run, after all others.
//
//   node scripts/ci-budget.mjs [budgets.json]
//
// Reads GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID
// and GITHUB_TOKEN; appends the table to GITHUB_STEP_SUMMARY when set.
import { appendFileSync, readFileSync } from "node:fs";
import { checkBudgets, renderBudgets, runJobs } from "./lib/ci-budget.mjs";

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** @param {string[]} argv */
async function main([path = ".github/ci-budgets.json"]) {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const run = `${api}/repos/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
  const jobs = await runJobs(run, env("GITHUB_TOKEN"));
  const rows = checkBudgets(jobs, JSON.parse(readFileSync(path, "utf8")));
  const table = renderBudgets(rows);
  process.stdout.write(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  const over = rows.filter((r) => r.over.length > 0);
  for (const r of over) process.stderr.write(`${r.name}: ${r.over.join(", ")}\n`);
  return over.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
