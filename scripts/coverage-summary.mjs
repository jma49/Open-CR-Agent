// Renders vitest's coverage/coverage-summary.json as a Markdown table, total
// and per package, for the CI job summary. Reporting only: no threshold.
//
//   node scripts/coverage-summary.mjs [coverage/coverage-summary.json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const METRICS = ["lines", "statements", "functions", "branches"];

export function packageOf(file) {
  return /(?:^|[\\/])packages[\\/]([^\\/]+)[\\/]/.exec(file)?.[1];
}

export function renderCoverage(summary) {
  const byPackage = new Map();
  for (const [file, metrics] of Object.entries(summary)) {
    if (file === "total") continue;
    const name = packageOf(file);
    if (!name) continue;
    const sums = byPackage.get(name) ?? Object.fromEntries(METRICS.map((m) => [m, [0, 0]]));
    for (const m of METRICS) {
      sums[m][0] += metrics[m].covered;
      sums[m][1] += metrics[m].total;
    }
    byPackage.set(name, sums);
  }
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
