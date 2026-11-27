import { describe, expect, it, vi } from "vitest";
import { ceiling, checkBudgets, renderBudgets, runJobs } from "./ci-budget.mjs";

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
    run_attempt: 1,
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
  it("reads all pages and keeps a prior overrun when only the budget job is retried", async () => {
    const verify = job("verify", { end: 82 });
    const budget = job("budget / budget", { end: 9, conclusion: "failure" });
    const retry = { ...budget, run_attempt: 2, conclusion: null, completed_at: null };
    const run = "https://api.example/repos/owner/repo/actions/runs/42";
    const page = `${run}/jobs?filter=all&per_page=100&page=`;
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { jobs: [verify, budget] },
          {
            headers: { link: `<${page}2>; rel="next"` },
          },
        ),
      )
      .mockResolvedValueOnce(Response.json({ jobs: [retry] }));
    const jobs = await runJobs(run, "test-token", request);
    expect(request.mock.calls.map(([url]) => url)).toEqual([`${page}1`, `${page}2`]);
    expect(checkBudgets(jobs, BUDGETS)).toEqual([
      {
        name: "verify",
        waiting: 2,
        setup: 5,
        running: 75,
        budget: 30,
        over: ["running 75 s > 30 s"],
      },
    ]);
  });

  it("replaces only the rerun matrix leg, regardless of API order", () => {
    const old = job("node-matrix (24)", { end: 99, conclusion: "failure" });
    const other = job("node-matrix (22)", { end: 98 });
    const retry = { ...job(old.name, { start: 110, end: 125 }), run_attempt: 2 };
    const rows = checkBudgets([retry, other, old], BUDGETS);
    expect(rows.map((r) => [r.name, r.running, r.over])).toEqual([
      [retry.name, 10, []],
      [other.name, 91, ["running 91 s > 90 s"]],
    ]);
  });

  it("uses the original timing when GitHub copies a job into a later attempt", () => {
    const original = job("verify", { end: 82 });
    const copy = { ...original, run_attempt: 2, created_at: "2026-01-01T00:20:00.000Z" };
    expect(checkBudgets([copy, original], BUDGETS)).toEqual(checkBudgets([original], BUDGETS));
  });

  it("passes jobs within their ceilings and reports waiting without judging it", () => {
    const [row] = checkBudgets([job("verify", { start: 40, end: 60 })], BUDGETS);
    expect(row).toEqual({
      name: "verify",
      waiting: 40,
      setup: 5,
      running: 15,
      budget: 30,
      over: [],
    });
  });

  it("fails a job that ran longer than its ceiling, matched without the matrix suffix", () => {
    const [row] = checkBudgets([job("node-matrix (24)", { end: 98 })], BUDGETS);
    expect(row?.budget).toBe(90);
    expect(row?.over).toEqual(["running 91 s > 90 s"]);
  });

  it("fails a job whose setup took longer than the setup ceiling", () => {
    const [row] = checkBudgets([job("commits", { end: 22, setup: 16 })], BUDGETS);
    expect(row?.over).toEqual(["setup 16 s > 15 s"]);
  });

  it("leaves the setup's time out of running", () => {
    const [row] = checkBudgets([job("verify", { end: 45, setup: 14 })], BUDGETS);
    expect(row?.running).toBe(29);
    expect(row?.over).toEqual([]);
  });

  it("counts a plain npm ci step as setup", () => {
    const plain = job("verify", { end: 22, setup: 16 });
    const [, install] = plain.steps;
    if (install) install.name = "Run npm ci";
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
    const table = renderBudgets(checkBudgets([job("node-matrix (24)", { end: 98 })], BUDGETS));
    expect(table).toContain(
      "| node-matrix (24) | 2 s | 5 s | 91 s | 90 s | over: running 91 s > 90 s |",
    );
  });
});
