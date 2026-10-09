// The verdict of scripts/fails-without.sh on its test run (lib/fails-without.mjs).
//
//   node scripts/fails-without.mjs <vitest exit code> <vitest log>
import { readFileSync } from "node:fs";
import { failsWithoutVerdict } from "./lib/fails-without.mjs";

const [status, log] = process.argv.slice(2);
if (status === undefined || log === undefined) {
  process.stderr.write("usage: fails-without.mjs <vitest exit code> <vitest log>\n");
  process.exit(2);
}
const verdict = failsWithoutVerdict(Number(status), readFileSync(log, "utf8"));
const out = verdict.ok ? process.stdout : process.stderr;
out.write(`${[...verdict.details, verdict.message].join("\n")}\n`);
process.exit(verdict.ok ? 0 : 1);
