import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Action's review step (action.yml), against a fake ocra that records
// its arguments and exits with FAKE_EXIT.
const script = fileURLToPath(new URL("./action-review.sh", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

const FAKE_OCRA = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_WAIT) {
  process.on("SIGINT", () => { writeFileSync(process.env.FAKE_ARGS + ".signal", "SIGINT"); process.exit(130); });
  writeFileSync(process.env.FAKE_ARGS + ".ready", "");
  setInterval(() => {}, 1000);
} else process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/** @param {Record<string, string>} env */
function setup(env) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-action-review-"));
  const work = join(dir, "work");
  mkdirSync(work);
  // A file the glob in args would expand to, were it expanded.
  writeFileSync(join(work, "match-me"), "");
  writeFileSync(join(dir, "ocra.mjs"), FAKE_OCRA);
  writeFileSync(join(dir, "output"), "");
  return {
    dir,
    work,
    env: {
      PATH: process.env.PATH ?? "",
      OCRA_MAIN: join(dir, "ocra.mjs"),
      OCRA_PR: "7",
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: join(dir, "output"),
      FAKE_ARGS: join(dir, "args.json"),
      ...env,
    },
  };
}

/** @param {Record<string, string>} env */
function review(env) {
  const t = setup(env);
  const result = spawnSync("bash", [script], { cwd: t.work, env: t.env, encoding: "utf8" });
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

  it("runs only on a pull request", () => {
    const r = review({ OCRA_PR: "" });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("::error::ocra review runs on pull_request events");
    expect(r.args).toBeUndefined();
  });

  it("forwards a cancellation to ocra as SIGINT", async () => {
    const t = setup({ FAKE_WAIT: "1" });
    const bash = spawn("bash", [script], { cwd: t.work, env: t.env, stdio: "ignore" });
    const ready = `${t.env.FAKE_ARGS}.ready`;
    for (let i = 0; i < 200 && !existsSync(ready); i++) await new Promise((r) => setTimeout(r, 25));
    bash.kill("SIGTERM");
    const status = await new Promise((resolve) => bash.on("close", resolve));
    expect(readFileSync(`${t.env.FAKE_ARGS}.signal`, "utf8")).toBe("SIGINT");
    expect(status).toBe(130);
  });
});
