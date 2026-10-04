// What the Action's outputs are, from a run's session report
// (scripts/action-outputs.mjs).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { errorMessage } from "./error-message.mjs";

/** @typedef {[name: string, value: string]} Output */

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
/**
 * @param {string[]} names
 * @param {string} started
 */
export function newestSession(names, started) {
  const runs = names.filter((n) => RUN_ID.test(n) && n >= started).sort();
  return runs.at(-1);
}

// The outputs a session report gives, as [name, value] pairs. The verdict is
// set only for a complete review (exit code 0 or 1): a run that reviewed
// nothing still writes a report whose verdict reads "approved", and a
// workflow that gates on the output must not take that for a pass.
/**
 * @param {unknown} json
 * @param {string} [exitCode]
 */
export function reportOutputs(json, exitCode) {
  if (json === null || typeof json !== "object") throw new Error("the report is not an object");
  const report = /** @type {{ runId?: unknown, verdict?: unknown, findings?: unknown }} */ (json);
  /** @type {Output[]} */
  const out = [];
  const complete = exitCode === undefined || exitCode === "0" || exitCode === "1";
  if (typeof report.runId === "string") out.push(["run-id", report.runId]);
  if (complete && typeof report.verdict === "string") out.push(["verdict", report.verdict]);
  if (Array.isArray(report.findings)) out.push(["findings", String(report.findings.length)]);
  return out;
}

// $GITHUB_OUTPUT lines. A value with a line break would let it set another
// output, so such a value is refused.
/** @param {readonly Output[]} pairs */
export function formatOutputs(pairs) {
  return pairs
    .map(([name, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`the output ${name} contains a line break`);
      return `${name}=${value}\n`;
    })
    .join("");
}

/** @param {{ env: Readonly<Record<string, string | undefined>>, root: string }} options */
export function collectOutputs({ env, root }) {
  /** @type {Output[]} */
  const pairs = [];
  /** @type {string[]} */
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
    pairs.push(...reportOutputs(report, env.OCRA_EXIT_CODE), ["report", copy]);
  } catch (error) {
    warnings.push(`could not read ocra's report ${source}: ${errorMessage(error)}`);
  }
  return { pairs, warnings };
}
