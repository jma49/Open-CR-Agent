// CI's recall-ceiling gate: compares `ocra-eval ceiling --dataset golden`
// (ceiling.json) with the committed baseline and fails when the
// deterministic stages reach fewer expected findings than they did.
//
//   node scripts/ceiling-gate.mjs <ceiling.json> [baseline.json]
//   node scripts/ceiling-gate.mjs <ceiling.json> [baseline.json] --write
//
// --write records the measurement as the new baseline; do that in the pull
// request that changes the golden cases or raises the ceiling.
import { readFileSync, writeFileSync } from "node:fs";
import {
  baselineOf,
  compareCeiling,
  DEFAULT_BASELINE,
  renderComparison,
} from "./lib/ceiling-gate.mjs";

/** @param {string[]} argv */
function main(argv) {
  const write = argv.includes("--write");
  const [ceilingPath, baselinePath = DEFAULT_BASELINE] = argv.filter((a) => a !== "--write");
  if (!ceilingPath) {
    process.stderr.write("usage: ceiling-gate.mjs <ceiling.json> [baseline.json] [--write]\n");
    return 2;
  }
  const current = baselineOf(JSON.parse(readFileSync(ceilingPath, "utf8")));
  if (write) {
    writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    process.stdout.write(`Wrote ${baselinePath}\n`);
    return 0;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const result = compareCeiling(baseline, current);
  process.stdout.write(renderComparison(baseline, current, result));
  return result.problems.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
