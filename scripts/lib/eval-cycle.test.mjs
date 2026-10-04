import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cycleState } from "./eval-cycle.mjs";

const QUOTA = /quota exceeded|rate limit[^)]*per[- ]day/i;

/**
 * @param {string[]} ids the run's cases
 * @param {Record<string, unknown>} results by id
 */
function runDir(ids, results) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cycle-"));
  mkdirSync(join(dir, "instances"));
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ids }));
  for (const [id, result] of Object.entries(results)) {
    writeFileSync(join(dir, "instances", `${id}.json`), JSON.stringify(result));
  }
  return dir;
}

describe("cycleState", () => {
  it("counts a cycle not started as one open case of none", () => {
    expect(cycleState(mkdtempSync(join(tmpdir(), "ocra-cycle-")), QUOTA)).toEqual({
      open: 1,
      total: 0,
    });
  });

  it("keeps a case open without a result, skipped, or lost to the quota", () => {
    const dir = runDir(["a", "b", "c", "d", "e"], {
      b: { status: "skipped_quota", tasks: [] },
      c: { status: "reviewed", tasks: [{ error: "Rate limit exceeded: free-models-per-day" }] },
      d: { status: "reviewed", tasks: [{ error: "HTTP 500" }, {}] },
      e: { status: "failed", tasks: [] },
    });
    expect(cycleState(dir, QUOTA)).toEqual({ open: 3, total: 5 });
  });

  it("refuses an id that could leave the run directory", () => {
    expect(() => cycleState(runDir(["../x"], {}), QUOTA)).toThrow("bad id in run.json");
    expect(() => cycleState(runDir([".hidden"], {}), QUOTA)).toThrow("bad id in run.json");
  });
});
