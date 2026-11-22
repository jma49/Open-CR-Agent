import { describe, expect, it } from "vitest";
import { ceiling, checkBudgets, renderBudgets } from "./ci-budget.mjs";

const BUDGETS = { setup: { platforms: 40, "*": 15 }, running: { "node-matrix": 90, "*": 30 } };

/**
 * A job created at 0 s, started at `start` s, finished at `end` s, whose
 * setup steps took `setup` s.
 * @param {string} name
 * @param {{ start?: number, end: number, setup?: number, conclusion?: string | null }} times
 */
function job(name, { start = 2, end, setup = 5, conclusion = "success" }) {
  const at = (/** @type {number} */ s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  return {
    name,
    conclusion,
    created_at: at(0),
    started_at: at(start),
    completed_at: at(end),
    steps: [
      { name: "Set up job", started_at: at(start), completed_at: at(start + 1) },
      {
        name: "Run ./.github/actions/setup",
        started_at: at(start + 1),
        completed_at: at(start + setup),
      },
      { name: "Run npm test", started_at: at(start + setup), completed_at: at(end) },
    ],
  };
}

describe("checkBudgets", () => {
  it("passes jobs within their ceilings and reports waiting without judging it", () => {
    const [row] = checkBudgets([job("verify", { start: 40, end: 60 })], BUDGETS);
    expect(row).toEqual({
      name: "verify",
      waiting: 40,
      setup: 5,
      running: 20,
      budget: 30,
      over: [],
    });
  });

  it("fails a job that ran longer than its ceiling, matched without the matrix suffix", () => {
    const [row] = checkBudgets([job("node-matrix (24)", { end: 95 })], BUDGETS);
    expect(row?.budget).toBe(90);
    expect(row?.over).toEqual(["running 93 s > 90 s"]);
  });

  it("fails a job whose setup took longer than the setup ceiling", () => {
    const [row] = checkBudgets([job("commits", { end: 22, setup: 16 })], BUDGETS);
    expect(row?.over).toEqual(["setup 16 s > 15 s"]);
  });

  it("counts a plain npm ci step as setup", () => {
    const plain = job("verify", { end: 22, setup: 16 });
    plain.steps[1] = { ...plain.steps[1], name: "Run npm ci" };
    const [row] = checkBudgets([plain], BUDGETS);
    expect(row?.setup).toBe(16);
    expect(row?.over).toEqual(["setup 16 s > 15 s"]);
  });

  it("judges failed jobs too, and leaves out skipped, cancelled and unfinished ones", () => {
    const rows = checkBudgets(
      [
        job("a", { end: 40, conclusion: "failure" }),
        job("b", { end: 40, conclusion: "skipped" }),
        job("c", { end: 40, conclusion: "cancelled" }),
        job("budget", { end: 40, conclusion: null }),
      ],
      BUDGETS,
    );
    expect(rows.map((r) => [r.name, r.over.length])).toEqual([["a", 1]]);
  });
});

describe("ceiling", () => {
  it("takes the job's own ceiling before the default", () => {
    expect(ceiling(BUDGETS.setup, "platforms (windows-latest)")).toBe(40);
    expect(ceiling(BUDGETS.setup, "verify")).toBe(15);
  });

  it("refuses a job no ceiling covers", () => {
    expect(() => ceiling({}, "image")).toThrow(/no ceiling/);
  });
});

describe("renderBudgets", () => {
  it("is a Markdown table with one row per job", () => {
    const table = renderBudgets(checkBudgets([job("node-matrix (24)", { end: 95 })], BUDGETS));
    expect(table).toContain(
      "| node-matrix (24) | 2 s | 5 s | 93 s | 90 s | over: running 93 s > 90 s |",
    );
  });
});
