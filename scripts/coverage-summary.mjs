// Renders vitest's coverage/coverage-summary.json as a Markdown table, total
// and per package, for the CI job summary. Reporting only: no threshold.
//
//   node scripts/coverage-summary.mjs [coverage/coverage-summary.json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const METRICS = /** @type {const} */ (["lines", "statements", "functions", "branches"]);

/** @param {string} file */
export function packageOf(file) {
  return /(?:^|[\\/])packages[\\/]([^\\/]+)[\\/]/.exec(file)?.[1];
}

/**
 * @typedef {(typeof METRICS)[number]} MetricName
 * @typedef {Record<MetricName, { covered: number, total: number }>} FileMetrics
 */

/** @param {Record<string, FileMetrics> & { total: FileMetrics }} summary */
export function renderCoverage(summary) {
  /** @type {Map<string, Record<MetricName, [number, number]>>} */
  const byPackage = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === "total") continue;
    const name = packageOf(file);
    if (!name) continue;
    const sums = byPackage.get(name) ?? {
      lines: [0, 0],
      statements: [0, 0],
      functions: [0, 0],
      branches: [0, 0],
    };
    for (const m of METRICS) {
      sums[m][0] += metrics[m].covered;
      sums[m][1] += metrics[m].total;
    }
    byPackage.set(name, sums);
  }
  /** @type {(covered: number, total: number) => string} */
  const pct = (covered, total) => (total === 0 ? "-" : `${((100 * covered) / total).toFixed(1)}%`);
  const lines = [
    "| Package | Lines | Statements | Functions | Branches |",
    "|---|---|---|---|---|",
    `| **total** | ${METRICS.map((m) => `**${pct(summary.total[m].covered, summary.total[m].total)}**`).join(" | ")} |`,
  ];
  for (const [name, sums] of [...byPackage].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`| ${name} | ${METRICS.map((m) => pct(...sums[m])).join(" | ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2] ?? "coverage/coverage-summary.json";
  process.stdout.write(`## Coverage\n\n${renderCoverage(JSON.parse(readFileSync(path, "utf8")))}`);
}
