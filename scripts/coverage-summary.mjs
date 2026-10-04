// Renders vitest's coverage/coverage-summary.json as a Markdown table, total
// and per package, for the CI job summary. Reporting only: no threshold.
//
//   node scripts/coverage-summary.mjs [coverage/coverage-summary.json]
import { readFileSync } from "node:fs";
import { renderCoverage } from "./lib/coverage-summary.mjs";

const path = process.argv[2] ?? "coverage/coverage-summary.json";
process.stdout.write(`## Coverage\n\n${renderCoverage(JSON.parse(readFileSync(path, "utf8")))}`);
