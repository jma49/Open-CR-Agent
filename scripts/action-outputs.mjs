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
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const SESSIONS_DIR = join(".ocra", "sessions");
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;

// The UTC stamp a run id starts with (see newRunId in core), to the second.
export function runStamp(now = new Date()) {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
}

// The newest session that started at or after `started`: run ids begin with
// their start time, so they sort in order. Sessions of earlier runs in the
// same checkout are older.
export function newestSession(names, started) {
  const runs = names.filter((n) => RUN_ID.test(n) && n >= started).sort();
  return runs.at(-1);
}

// The outputs a session report gives, as [name, value] pairs.
export function reportOutputs(report) {
  if (report === null || typeof report !== "object") throw new Error("the report is not an object");
  const out = [];
  if (typeof report.runId === "string") out.push(["run-id", report.runId]);
  if (typeof report.verdict === "string") out.push(["verdict", report.verdict]);
  if (Array.isArray(report.findings)) out.push(["findings", String(report.findings.length)]);
  return out;
}

// $GITHUB_OUTPUT lines. A value with a line break would let it set another
// output, so such a value is refused.
export function formatOutputs(pairs) {
  return pairs
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`the output ${name} contains a line break`);
      return `${name}=${value}\n`;
    })
    .join("");
}

function repositoryRoot() {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : process.cwd();
}

export function collectOutputs({ env, root }) {
  const pairs = [];
  const warnings = [];
  if (env.OCRA_EXIT_CODE) pairs.push(["exit-code", env.OCRA_EXIT_CODE]);
  const sarif = env.OCRA_SARIF_FILE;
  if (sarif && existsSync(sarif)) pairs.push(["sarif", sarif]);

  const sessions = join(root, SESSIONS_DIR);
  const names = existsSync(sessions) ? readdirSync(sessions) : [];
  const id = newestSession(names, env.OCRA_STARTED ?? "");
  const source = id === undefined ? undefined : join(sessions, id, "report.json");
  if (source === undefined || !existsSync(source)) {
    warnings.push(
      "ocra wrote no report, so the outputs verdict, run-id, findings and report are empty",
    );
    return { pairs, warnings };
  }
  try {
    const report = JSON.parse(readFileSync(source, "utf8"));
    const copy = join(env.RUNNER_TEMP ?? root, "ocra", "report.json");
    mkdirSync(resolve(copy, ".."), { recursive: true });
    copyFileSync(source, copy);
    pairs.push(...reportOutputs(report), ["report", copy]);
  } catch (error) {
    warnings.push(`could not read ocra's report ${source}: ${error.message}`);
  }
  return { pairs, warnings };
}

function main() {
  try {
    const { pairs, warnings } = collectOutputs({ env: process.env, root: repositoryRoot() });
    for (const warning of warnings) console.log(`::warning::${warning}`);
    const lines = formatOutputs(pairs);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
    else process.stdout.write(lines);
  } catch (error) {
    console.log(`::warning::could not set the Action's outputs: ${error.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
