// What the Action's outputs are, from a run's session report
// (scripts/action-outputs.mjs).

import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errorMessage } from "./error-message.mjs";

/** @typedef {[name: string, value: string]} Output */
/** @typedef {Readonly<Record<string, string | undefined>>} Env */

export const SESSIONS_DIR = join(".ocra", "sessions");
const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SNAPSHOT = "sessions-before.json";

// The checkout is the pull request's: sessions, or a link in place of a
// directory ocra writes, may have come with the change. ocra refuses to
// write its session through a link, and the Action reads none.
/** @param {string} root */
function sessionsDir(root) {
  for (const dir of [join(root, ".ocra"), join(root, SESSIONS_DIR)]) {
    if (lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`${dir} is a symbolic link`);
    }
  }
  return join(root, SESSIONS_DIR);
}

/** @param {string} root */
function sessionNames(root) {
  const dir = sessionsDir(root);
  return existsSync(dir) ? readdirSync(dir).filter((name) => RUN_ID.test(name)) : [];
}

// Where the Action keeps its own files: the runner's, not the checkout's.
/** @param {Env} env */
function actionDir(env) {
  if (!env.RUNNER_TEMP) throw new Error("RUNNER_TEMP is not set");
  return join(env.RUNNER_TEMP, "ocra");
}

// The sessions in the checkout before ocra runs, kept under $RUNNER_TEMP
// out of the change's reach: this run's session is the one that appears.
/** @param {{ env: Env, root: string }} options */
export function recordSessions({ env, root }) {
  const file = join(actionDir(env), SNAPSHOT);
  // A list left by an earlier step of the job must not stand in for this one.
  rmSync(file, { force: true });
  const names = sessionNames(root);
  mkdirSync(actionDir(env), { recursive: true });
  writeFileSync(file, JSON.stringify(names));
}

// The session this run wrote: the one run id that was not there before. A
// session that came with the change was there before, whatever time its
// name claims.
/**
 * @param {readonly string[]} before
 * @param {readonly string[]} after
 */
export function sessionOfRun(before, after) {
  const known = new Set(before);
  const added = after.filter((name) => RUN_ID.test(name) && !known.has(name));
  return added.length === 1 ? added[0] : undefined;
}

// The report's bytes, refusing a link at the session directory or the file.
// Where there is no O_NOFOLLOW (Windows) the checks before the open stand
// alone: nothing that came with the change runs during the step to swap a
// file in between.
/** @param {string} sessionDir */
function readReport(sessionDir) {
  const report = join(sessionDir, "report.json");
  for (const path of [sessionDir, report]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symbolic link`);
  }
  const fd = openSync(report, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${report} is not a regular file`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
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

const EMPTY = "so the outputs verdict, run-id, findings and report are empty";

/** @param {{ env: Env, root: string }} options */
export function collectOutputs({ env, root }) {
  /** @type {Output[]} */
  const pairs = [];
  /** @type {string[]} */
  const warnings = [];
  if (env.OCRA_EXIT_CODE) pairs.push(["exit-code", env.OCRA_EXIT_CODE]);
  const sarif = env.OCRA_SARIF_FILE;
  if (sarif && existsSync(sarif)) pairs.push(["sarif", sarif]);

  /** @type {string | undefined} */
  let sessionDir;
  try {
    const before = JSON.parse(readFileSync(join(actionDir(env), SNAPSHOT), "utf8"));
    if (!Array.isArray(before)) throw new Error(`${SNAPSHOT} is not a list`);
    const id = sessionOfRun(before, sessionNames(root));
    sessionDir = id === undefined ? undefined : join(sessionsDir(root), id);
  } catch (error) {
    warnings.push(`could not tell which session ocra wrote (${errorMessage(error)}), ${EMPTY}`);
    return { pairs, warnings };
  }
  if (sessionDir === undefined || !existsSync(join(sessionDir, "report.json"))) {
    warnings.push(`ocra wrote no report, ${EMPTY}`);
    return { pairs, warnings };
  }
  try {
    const bytes = readReport(sessionDir);
    const report = JSON.parse(bytes.toString("utf8"));
    const copy = join(actionDir(env), "report.json");
    writeFileSync(copy, bytes);
    pairs.push(...reportOutputs(report, env.OCRA_EXIT_CODE), ["report", copy]);
  } catch (error) {
    warnings.push(`could not read ocra's report in ${sessionDir}: ${errorMessage(error)}`);
  }
  return { pairs, warnings };
}
