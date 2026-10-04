// The Action's outputs, set after `ocra review` has run: its exit code, and
// from the run's session report (`.ocra/sessions/<run id>/report.json`, the
// same shape as `--format json`) the run id, the verdict, the number of
// findings and a copy of the report under $RUNNER_TEMP. The session report is
// read rather than stdout so that `args` keep every output format, `--format
// sarif` included.
//
// It never fails the step: a missing or unreadable report only leaves those
// outputs empty, with a warning, and the job keeps ocra's exit behavior.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { collectOutputs, formatOutputs } from "./lib/action-outputs.mjs";
import { errorMessage } from "./lib/error-message.mjs";

function repositoryRoot() {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : process.cwd();
}

function main() {
  try {
    const { pairs, warnings } = collectOutputs({ env: process.env, root: repositoryRoot() });
    for (const warning of warnings) console.log(`::warning::${warning}`);
    const lines = formatOutputs(pairs);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
    else process.stdout.write(lines);
  } catch (error) {
    console.log(`::warning::could not set the Action's outputs: ${errorMessage(error)}`);
  }
}

main();
