import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Action's review step, run as the runner runs it: action.yml's `run:`
// in a step file under `bash -eo pipefail`, against a fake ocra that records
// its arguments and exits with FAKE_EXIT.
const root = fileURLToPath(new URL("..", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

/** The one-line `run:` of action.yml's Review step. */
function reviewRun() {
  const lines = readFileSync(join(root, "action.yml"), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Review");
  const run = lines.slice(step).find((line) => line.trimStart().startsWith("run: "));
  if (step < 0 || !run) throw new Error("action.yml has no Review step with a one-line run:");
  return run.trimStart().slice("run: ".length);
}

// Writes its session report under FAKE_SESSION, as ocra does. Waits for
// SIGINT when FAKE_WAIT is set; exits on its own after a while so that a run
// whose signal never reached it does not outlive the test.
const FAKE_OCRA = `import { mkdirSync, writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_SESSION) {
  const dir = ".ocra/sessions/" + process.env.FAKE_SESSION;
  mkdirSync(dir, { recursive: true });
  writeFileSync(dir + "/report.json", JSON.stringify({ version: 1, runId: process.env.FAKE_SESSION, verdict: "minor_issues", findings: [{}] }));
}
if (process.env.FAKE_WAIT) {
  process.on("SIGINT", () => { writeFileSync(process.env.FAKE_ARGS + ".signal", "SIGINT"); process.exit(130); });
  writeFileSync(process.env.FAKE_ARGS + ".ready", "");
  setTimeout(() => process.exit(0), 5000);
} else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/**
 * A session report laid out as ocra writes it, under `sessions`.
 * @param {string} sessions
 * @param {string} id
 */
function plantSession(sessions, id) {
  mkdirSync(join(sessions, id), { recursive: true });
  const report = { version: 1, runId: id, verdict: "approved", findings: [] };
  writeFileSync(join(sessions, id, "report.json"), JSON.stringify(report));
}

/**
 * @param {Record<string, string>} env
 * @param {(work: string, dir: string) => void} [checkout] lays out what came with the change
 */
function setup(env, checkout) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-action-review-"));
  const work = join(dir, "work");
  mkdirSync(work);
  checkout?.(work, dir);
  // A file the glob in args would expand to, were it expanded.
  writeFileSync(join(work, "match-me"), "");
  writeFileSync(join(dir, "ocra.mjs"), FAKE_OCRA);
  writeFileSync(join(dir, "output"), "");
  const step = join(dir, "step.sh");
  writeFileSync(step, `${reviewRun()}\n`);
  return {
    dir,
    work,
    // GitHub's command line for a bash step.
    argv: ["--noprofile", "--norc", "-eo", "pipefail", step],
    env: {
      PATH: process.env.PATH ?? "",
      GITHUB_ACTION_PATH: root,
      OCRA_MAIN: join(dir, "ocra.mjs"),
      OCRA_PR: "7",
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: join(dir, "output"),
      FAKE_ARGS: join(dir, "args.json"),
      ...env,
    },
  };
}

/**
 * @param {Record<string, string>} env
 * @param {(work: string, dir: string) => void} [checkout]
 */
function review(env, checkout) {
  const t = setup(env, checkout);
  const result = spawnSync("bash", t.argv, { cwd: t.work, env: t.env, encoding: "utf8" });
  /** @type {string[] | undefined} */
  let args;
  try {
    args = JSON.parse(readFileSync(t.env.FAKE_ARGS, "utf8"));
  } catch {}
  return {
    status: result.status,
    stdout: result.stdout,
    args,
    outputs: readFileSync(t.env.GITHUB_OUTPUT, "utf8"),
    dir: t.dir,
  };
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!hasBash)("the Action's review step", () => {
  it("passes args split on whitespace, unexpanded, before the SARIF flags", () => {
    const r = review({ OCRA_ARGS: "--max-cost-usd 2\n  --exclude match-*", OCRA_SARIF: "true" });
    expect(r.status).toBe(0);
    expect(r.args).toEqual([
      "review",
      "--pr",
      "7",
      "--publish",
      "--max-cost-usd",
      "2",
      "--exclude",
      "match-*",
      "--format",
      "sarif",
      "--output",
      join(r.dir, "ocra", "ocra.sarif"),
    ]);
  });

  it("passes concerns (exit 1) unless fail-on-concerns is set, and reports ocra's exit code", () => {
    const passing = review({ FAKE_EXIT: "1" });
    expect(passing.status).toBe(0);
    expect(passing.outputs).toContain("exit-code=1\n");
    expect(review({ FAKE_EXIT: "1", OCRA_FAIL_ON_CONCERNS: "true" }).status).toBe(1);
    expect(review({ FAKE_EXIT: "3" }).status).toBe(3);
  });

  it("sets the outputs from the session this run wrote, not one that came with the change", () => {
    const run = "20261009T120000Z-a1b2c3";
    const r = review({ FAKE_SESSION: run }, (work) =>
      plantSession(join(work, ".ocra", "sessions"), "20991231T235959Z-ffffff"),
    );
    expect(r.outputs).toContain(`run-id=${run}\n`);
    expect(r.outputs).toContain("verdict=minor_issues\n");
    expect(r.outputs).toContain("findings=1\n");
    expect(r.outputs).not.toContain("20991231T235959Z");
  });

  it("reads no session through a link that came with the change", () => {
    const r = review({}, (work, dir) => {
      plantSession(join(dir, "elsewhere", "sessions"), "20991231T235959Z-ffffff");
      symlinkSync(join(dir, "elsewhere"), join(work, ".ocra"), "junction");
    });
    expect(r.outputs).toBe("exit-code=0\n");
    expect(r.stdout).toContain("::warning::");
  });

  it("runs only on a pull request", () => {
    const r = review({ OCRA_PR: "" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("::error::ocra review runs on pull_request events");
    expect(r.args).toBeUndefined();
  });

  // The runner signals the step's own shell when a run is cancelled.
  it.each(["SIGINT", "SIGTERM"])(
    "forwards a cancellation (%s to the step) to ocra as SIGINT",
    async (signal) => {
      const t = setup({ FAKE_WAIT: "1" });
      const step = spawn("bash", t.argv, { cwd: t.work, env: t.env, stdio: "ignore" });
      const closed = new Promise((resolve) => step.on("close", resolve));
      const ready = `${t.env.FAKE_ARGS}.ready`;
      for (let i = 0; i < 200 && !existsSync(ready); i++) await sleep(25);
      step.kill(/** @type {NodeJS.Signals} */ (signal));
      const signalled = `${t.env.FAKE_ARGS}.signal`;
      for (let i = 0; i < 80 && !existsSync(signalled); i++) await sleep(25);
      expect(existsSync(signalled)).toBe(true);
      expect(await closed).toBe(130);
    },
  );
});
