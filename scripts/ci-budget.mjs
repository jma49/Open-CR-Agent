// CI's time budgets: reads the jobs of this workflow run from the Actions
// API and fails when a finished job ran or set up longer than its ceiling in
// the budgets file. Waiting is reported, not judged: it depends on the
// runners, not on the repository. The last job of a run, after all others.
//
//   node scripts/ci-budget.mjs [budgets.json]
//
// Reads GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT
// and GITHUB_TOKEN; appends the table to GITHUB_STEP_SUMMARY when set.
import { appendFileSync, readFileSync } from "node:fs";
import { checkBudgets, renderBudgets } from "./lib/ci-budget.mjs";

/** @param {string} name */
function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function runJobs() {
  const api = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const url = `${api}/repos/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}/attempts/${env("GITHUB_RUN_ATTEMPT")}/jobs?per_page=100`;
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      accept: "application/vnd.github+json",
    },
  });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return /** @type {{ jobs: import("./lib/ci-budget.mjs").Job[] }} */ (await response.json()).jobs;
}

/** @param {string[]} argv */
async function main([path = ".github/ci-budgets.json"]) {
  const rows = checkBudgets(await runJobs(), JSON.parse(readFileSync(path, "utf8")));
  const table = renderBudgets(rows);
  process.stdout.write(table);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  const over = rows.filter((r) => r.over.length > 0);
  for (const r of over) process.stderr.write(`${r.name}: ${r.over.join(", ")}\n`);
  return over.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
