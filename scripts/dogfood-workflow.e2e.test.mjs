import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The dogfood workflow's scripted steps live next to the action that runs
// them (.github/actions/dogfood), because a called workflow runs in the
// caller's checkout, where this repository's files are not. These tests run
// those scripts against a fake `gh`, and check the workflow's contract.
const workflowPath = fileURLToPath(
  new URL("../.github/workflows/ocra-dogfood.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

/** @param {"guard" | "free-outcome" | "cost"} step */
const stepScript = (step) =>
  fileURLToPath(new URL(`../.github/actions/dogfood/${step}.sh`, import.meta.url));

const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
const hasJq = spawnSync("jq", ["--version"]).status === 0;
const today = () => new Date().toISOString().slice(0, 10);
// A GitHub Actions expression, as the workflow spells it.
/** @param {string} inner */
const expression = (inner) => `\${{ ${inner} }}`;

/**
 * @typedef {object} GuardOptions
 * @property {[string, string][]} [listing] the ledger's artifacts, as `gh` lists them
 * @property {boolean} [ghFails]
 * @property {string} [budget]
 * @property {string} [switch]
 * @property {string} [source]
 * @property {string} [key]
 * @property {string} [left] the free requests the free-quota step reported
 */

/** @param {GuardOptions} [options] */
function runGuard({
  listing = [],
  ghFails = false,
  budget = "24",
  switch: on = "on",
  source = "vertex",
  key = "",
  left = "",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-guard-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "listing"), listing.map(([day, name]) => `${day} ${name}\n`).join(""));
  writeFileSync(
    join(bin, "gh"),
    ghFails
      ? "#!/bin/sh\necho 'HTTP 502' >&2\nexit 1\n"
      : `#!/bin/sh\ncat '${join(dir, "listing")}'\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);
  const output = join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [stepScript("guard")], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      REPOSITORY: "o/r",
      SWITCH: on,
      BUDGET_USD: budget,
      DAILY_USD: "2",
      CAP_USD: "2",
      SOURCE: source,
      OPENROUTER_API_KEY: key,
      FREE_LEFT: left,
      FREE_MODEL: "vendor/free",
      FREE_MAX_TASKS: "8",
      FREE_MIN_REQUESTS: "40",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("=")),
  );
  let summary = "";
  try {
    summary = readFileSync(join(dir, "summary"), "utf8");
  } catch {}
  return { status: result.status, outputs, summary, stdout: result.stdout };
}

describe.skipIf(!hasBash)("dogfood budget guard", () => {
  const old = "2026-09-01";

  it("allows a review on an empty ledger and reserves one and a half caps", () => {
    const { status, outputs } = runGuard();
    expect(status).toBe(0);
    expect(outputs).toEqual({ allowed: "true", reserve: "300" });
  });

  it("stops when the next review could pass the budget", () => {
    // $21.00 spent: $21.00 + $3.00 reaches the $24 budget exactly, so one more runs.
    const at = runGuard({ listing: [[old, "ocra-cost-1-1-c2100"]] });
    expect(at.outputs.allowed).toBe("true");
    const over = runGuard({ listing: [[old, "ocra-cost-1-1-c2101"]] });
    expect(over.outputs.allowed).toBe("false");
    expect(over.summary).toContain("budget of $24.00 is spent");
  });

  it("counts a review by what it spent once recorded, and by its reservation until then", () => {
    const recorded = runGuard({
      listing: [
        [old, "ocra-cost-7-1-r300"],
        [old, "ocra-cost-7-1-c50"],
      ],
    });
    expect(recorded.summary).toContain("Spent $0.50 of $24.00 over 1 review(s)");
    // A job that died after reserving and before recording still counts.
    const unrecorded = runGuard({ listing: [[old, "ocra-cost-8-1-r300"]] });
    expect(unrecorded.summary).toContain("Spent $3.00 of $24.00 over 1 review(s)");
    // Attempts are separate reviews.
    const rerun = runGuard({
      listing: [
        [old, "ocra-cost-9-1-c100"],
        [old, "ocra-cost-9-2-r300"],
      ],
    });
    expect(rerun.summary).toContain("Spent $4.00 of $24.00 over 2 review(s)");
  });

  it("counts a name it did not write as a full reservation", () => {
    const { summary } = runGuard({ listing: [[old, "ocra-cost-oops"]] });
    expect(summary).toContain("Spent $3.00");
  });

  it("stops for the day once today's allowance is spent", () => {
    const { outputs, summary } = runGuard({ listing: [[today(), "ocra-cost-3-1-c200"]] });
    expect(outputs.allowed).toBe("false");
    expect(summary).toContain("today's $2.00 is spent");
  });

  it("starts nothing while the switch is off", () => {
    const { outputs, summary } = runGuard({ switch: "off" });
    expect(outputs.allowed).toBe("false");
    expect(summary).toContain("reviews are off");
  });

  it("fails before spending when the ledger cannot be read or the budget is not a number", () => {
    expect(runGuard({ ghFails: true }).status).not.toBe(0);
    expect(runGuard({ ghFails: true }).outputs.allowed).toBeUndefined();
    expect(runGuard({ budget: "" }).status).not.toBe(0);
    expect(runGuard({ budget: "1e9" }).status).not.toBe(0);
  });
});

describe.skipIf(!hasBash || !hasJq)("dogfood guard on the free model", () => {
  // The free-quota step's count (scripts/lib/free-quota.e2e.test.mjs reads it
  // from OpenRouter's answers).
  it("allows a review without a ledger while the day has requests left", () => {
    const { status, outputs, summary } = runGuard({
      source: "openrouter",
      key: "k",
      left: "600",
      ghFails: true,
    });
    expect(status).toBe(0);
    expect(outputs).toEqual({ allowed: "true" });
    expect(summary).toContain("free requests left today: 600");
  });

  it("skips with a notice when the day's free requests are nearly spent", () => {
    const { status, outputs, stdout } = runGuard({ source: "openrouter", key: "k", left: "12" });
    expect(status).toBe(0);
    expect(outputs.allowed).toBe("false");
    expect(stdout).toContain("::notice title=No ocra review::the free model quota is spent");
    const refused = runGuard({ source: "openrouter", key: "k", left: "0" });
    expect(refused.outputs.allowed).toBe("false");
    expect(refused.stdout).toContain("(0 request(s) left)");
  });

  it("reviews when OpenRouter does not report the quota", () => {
    expect(runGuard({ source: "openrouter", key: "k" }).outputs.allowed).toBe("true");
  });

  it("starts nothing while the switch is off, and fails without a key or on an unknown source", () => {
    const off = runGuard({ source: "openrouter", key: "k", left: "600", switch: "off" });
    expect(off.outputs.allowed).toBe("false");
    expect(runGuard({ source: "openrouter", left: "600" }).status).not.toBe(0);
    expect(runGuard({ source: "gemini" }).status).not.toBe(0);
  });
});

/** @param {{ report?: unknown, exitCode: string }} options */
function runFreeOutcome({ report, exitCode }) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-free-"));
  const file = join(dir, "report.json");
  if (report !== undefined) writeFileSync(file, JSON.stringify(report));
  const result = spawnSync("bash", [stepScript("free-outcome")], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      EXIT_CODE: exitCode,
      REPORT: report === undefined ? "" : file,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    },
  });
  return { status: result.status, stdout: result.stdout };
}

describe.skipIf(!hasBash || !hasJq)("dogfood free model outcome", () => {
  const quota = { status: "failed", error: "HTTP 429: free-models-per-day-stealth" };

  it("reads a review that every task lost to the quota as skipped, not failed", () => {
    const { status, stdout } = runFreeOutcome({ report: { tasks: [quota, quota] }, exitCode: "2" });
    expect(status).toBe(0);
    expect(stdout).toContain("::notice title=No ocra review::the free model quota is spent");
  });

  it("says when the quota ran out during a review", () => {
    const { stdout } = runFreeOutcome({
      report: { tasks: [{ status: "completed" }, quota] },
      exitCode: "3",
    });
    expect(stdout).toContain("::notice title=Incomplete ocra review::");
  });

  it("warns on other failures and stays quiet on a finished review", () => {
    const failed = runFreeOutcome({
      report: { tasks: [{ status: "failed", error: "boom" }] },
      exitCode: "2",
    });
    expect(failed.stdout).toContain("::warning");
    expect(runFreeOutcome({ exitCode: "2" }).stdout).toContain("::warning");
    expect(
      runFreeOutcome({ report: { tasks: [{ status: "completed" }] }, exitCode: "0" }).stdout,
    ).toBe("");
  });
});

/** @param {{ report?: string, outcome?: string, markAfterReport?: boolean }} [options] */
function runCost({ report, outcome = "success", markAfterReport = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cost-"));
  const temp = join(dir, "temp");
  mkdirSync(temp);
  const mark = join(temp, "ocra-review-start");
  writeFileSync(mark, "");
  const past = new Date(Date.now() - 60_000);
  if (!markAfterReport) utimesSync(mark, past, past);
  if (report !== undefined) {
    mkdirSync(join(dir, ".ocra/sessions/s1"), { recursive: true });
    const file = join(dir, ".ocra/sessions/s1/report.json");
    writeFileSync(file, report);
    if (markAfterReport) utimesSync(file, past, past);
  }
  const output = join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [stepScript("cost")], {
    cwd: dir,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      RUNNER_TEMP: temp,
      REVIEW_OUTCOME: outcome,
      CAP_USD: "2",
      RUN_ID: "42",
      RUN_ATTEMPT: "1",
      PULL_REQUEST: "5",
      HEAD_SHA: "abc",
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: join(dir, "summary"),
    },
  });
  return { status: result.status, output: readFileSync(output, "utf8").trim() };
}

describe.skipIf(!hasBash || !hasJq)("dogfood cost recorder", () => {
  it("records what this run's report says it spent, rounded up to a cent", () => {
    const { status, output } = runCost({ report: JSON.stringify({ usage: { costUsd: 1.234 } }) });
    expect(status).toBe(0);
    expect(output).toBe("name=ocra-cost-42-1-c124");
  });

  it("ignores a report older than the review, as one committed in the pull request is", () => {
    const { output } = runCost({
      report: JSON.stringify({ usage: { costUsd: 0 } }),
      markAfterReport: true,
    });
    expect(output).toBe("name=ocra-cost-42-1-c200");
  });

  it("counts a review that ran without a readable report at the cap, and one that never ran at zero", () => {
    expect(runCost({ report: "{not json" }).output).toBe("name=ocra-cost-42-1-c200");
    expect(runCost({ outcome: "failure" }).output).toBe("name=ocra-cost-42-1-c200");
    expect(runCost({ outcome: "skipped" }).output).toBe("name=ocra-cost-42-1-c0");
  });
});

describe("dogfood workflow contract", () => {
  it("takes nothing from its caller that sets the budget, the switch or the cap", () => {
    // A pull request can edit the caller, so every number the guard uses
    // comes from repository variables or from this file. The one input picks
    // where models come from; the Vertex budget applies whichever it names.
    const inputs = workflow.match(/^ {4}inputs:\n((?: {6}.*\n| {8,}.*\n)*)/m);
    expect(inputs?.[1]?.match(/^ {6}\S.*$/gm)).toEqual(["      model-source:"]);
    expect(workflow).toContain(`BUDGET_USD: ${expression("vars.OCRA_REVIEW_BUDGET_USD")}`);
    expect(workflow).toContain(`SWITCH: ${expression("vars.OCRA_REVIEW")}`);
    expect(workflow).toMatch(/if: >-\n\s+vars\.OCRA_REVIEW == 'on' &&/);
  });

  it("is called at main by ocra's own caller, the only ref Google Cloud trusts", () => {
    const callerPath = fileURLToPath(
      new URL("../.github/workflows/ocra-review.yml", import.meta.url),
    );
    const caller = readFileSync(callerPath, "utf8");
    expect(caller).toMatch(
      /^ {4}uses: jma49\/Open-CR-Agent\/\.github\/workflows\/ocra-dogfood\.yml@main$/m,
    );
    expect(caller).toMatch(/^ {4}with:\n {6}model-source: openrouter\n {4}secrets:/m);
  });

  it("runs its scripted steps through the dogfood action at main", () => {
    for (const step of ["guard", "free-outcome", "cost"]) {
      expect(workflow).toMatch(
        new RegExp(
          `uses: jma49/Open-CR-Agent/\\.github/actions/dogfood@main\n(?: {8}.*\n)*? {8}with:\n {10}step: ${step}\n`,
        ),
      );
    }
    expect(workflow).not.toMatch(/uses: \.\/\.github\/actions\/dogfood/);
  });

  it("takes the free-quota action at main, the ref it runs from itself", () => {
    // The job has no checkout of this repository; the action brings its
    // script, and a pull request's copy of either never runs here.
    expect(workflow).toMatch(
      /^ {8}uses: jma49\/Open-CR-Agent\/\.github\/actions\/free-quota@main$/m,
    );
  });

  it("records a reservation before it authenticates", () => {
    /** @param {string} text */
    const at = (text) => workflow.indexOf(text);
    const reservation = `name: ${expression("steps.reserve.outputs.name")}`;
    expect(at(reservation)).toBeGreaterThan(0);
    expect(at(reservation)).toBeLessThan(at("google-github-actions/auth@"));
  });
});
