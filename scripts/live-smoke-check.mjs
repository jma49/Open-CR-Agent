// Checks the nightly live smoke's report (nightly-live.yml): a complete
// review on the free model at no cost. Exits 1 with the problems otherwise.
//
//   MODEL=… node scripts/live-smoke-check.mjs <report.json>
import { readFileSync } from "node:fs";
import { smokeLine, smokeProblems } from "./lib/live-smoke.mjs";

const path = process.argv[2];
const model = process.env.MODEL;
if (!path || !model) {
  console.error("usage: MODEL=… node scripts/live-smoke-check.mjs <report.json>");
  process.exit(2);
}
const report = JSON.parse(readFileSync(path, "utf8"));
const problems = smokeProblems(report, model);
console.log(smokeLine(report));
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
