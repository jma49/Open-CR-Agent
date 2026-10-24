// Checks the nightly live smoke's review (nightly-live.yml): a complete
// review on the free model at no cost. Prints error annotations and exits 1
// otherwise.
//
//   MODEL=… EXIT=<ocra review's exit code> node scripts/live-smoke-check.mjs <report.json>
import { existsSync, readFileSync } from "node:fs";
import { smokeErrors, smokeLine } from "./lib/live-smoke.mjs";

const path = process.argv[2];
const { MODEL: model, EXIT: exitCode } = process.env;
if (!path || !model || !exitCode) {
  console.error("usage: MODEL=… EXIT=… node scripts/live-smoke-check.mjs <report.json>");
  process.exit(2);
}
const report = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
if (report) console.log(smokeLine(report));
const errors = smokeErrors(report, model, exitCode);
for (const error of errors) console.log(error);
process.exit(errors.length > 0 ? 1 : 0);
