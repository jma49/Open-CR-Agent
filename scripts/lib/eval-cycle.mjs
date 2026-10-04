// Where a free eval cycle stands (scripts/eval-cycle.mjs).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ID = /^[A-Za-z0-9_.@-]+$/;

/**
 * The cases of a run directory still to review, and all of them. A case is
 * open without a result, when it was skipped, or when a task of it failed on
 * the quota (`quota`, matched without case). A directory without run.json is
 * a cycle not started yet: one open case of none.
 * @param {string} dir
 * @param {RegExp} quota
 * @returns {{ open: number, total: number }}
 */
export function cycleState(dir, quota) {
  const runFile = join(dir, "run.json");
  if (!existsSync(runFile)) return { open: 1, total: 0 };
  const ids = readJson(runFile)?.ids;
  let open = 0;
  let total = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== "string" || !ID.test(id) || id.startsWith(".")) {
      throw new Error("bad id in run.json");
    }
    total += 1;
    const file = join(dir, "instances", `${id}.json`);
    if (!existsSync(file) || isOpen(readJson(file), quota)) open += 1;
  }
  return { open, total };
}

/**
 * @param {unknown} result
 * @param {RegExp} quota
 */
function isOpen(result, quota) {
  if (typeof result !== "object" || result === null) return false;
  const { status, tasks } = /** @type {{ status?: unknown, tasks?: unknown }} */ (result);
  if (typeof status === "string" && status.startsWith("skipped")) return true;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((task) => {
    const error = /** @type {{ error?: unknown } | null} */ (task)?.error;
    return typeof error === "string" && quota.test(error);
  });
}

// A file that does not parse counts as nothing: the cycle neither stops on it
// nor reviews it again.
/** @param {string} path */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
