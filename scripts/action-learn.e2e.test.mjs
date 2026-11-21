import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The Action's learn step, run as the runner runs it: action.yml's `run:`
// in a step file under `bash -eo pipefail`, against a fake ocra that records
// its arguments, prints FAKE_OUT and exits with FAKE_EXIT.
const root = fileURLToPath(new URL("..", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The one-line `run:` of action.yml's Learn step. */
function learnRun() {
  const lines = readFileSync(join(root, "action.yml"), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Learn");
  const run = lines.slice(step).find((line) => line.trimStart().startsWith("run: "));
  if (step < 0 || !run) throw new Error("action.yml has no Learn step with a one-line run:");
  return run.trimStart().slice("run: ".length);
}

const FAKE_OCRA = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.FAKE_OUT ?? "");
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/** @param {Record<string, string>} env */
function learn(env) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-action-learn-"));
  dirs.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  writeFileSync(join(work, "match-me"), "");
  writeFileSync(join(dir, "ocra.mjs"), FAKE_OCRA);
  writeFileSync(join(dir, "output"), "");
  const step = join(dir, "step.sh");
  writeFileSync(step, `${learnRun()}\n`);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", step], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GITHUB_ACTION_PATH: root,
      OCRA_MAIN: join(dir, "ocra.mjs"),
      RUNNER_TEMP: dir,
      GITHUB_OUTPUT: join(dir, "output"),
      FAKE_ARGS: join(dir, "args.json"),
      ...env,
    },
  });
  /** @type {string[] | undefined} */
  let args;
  try {
    args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
  } catch {}
  return {
    status: result.status,
    stdout: result.stdout,
    args,
    outputs: readFileSync(join(dir, "output"), "utf8"),
  };
}

const PULL = "https://github.com/o/r/pull/9";

describe.skipIf(!hasBash)("the Action's learn step", () => {
  it("proposes the fix commits' learnings and sets the proposal output", () => {
    const r = learn({ OCRA_LEARN: "mine", OCRA_ARGS: "--max 5 match-*", FAKE_OUT: `${PULL}\n` });
    expect(r.status).toBe(0);
    expect(r.args).toEqual(["learn", "mine", "--propose", "--max", "5", "match-*"]);
    expect(r.outputs).toBe(`proposal=${PULL}\n`);
    expect(r.stdout).toContain(PULL);
  });

  it("reads the notes of the pull request the comment is on", () => {
    const r = learn({ OCRA_LEARN: "remember", OCRA_PR: "7" });
    expect(r.args).toEqual(["learn", "remember", "--pr", "7", "--propose"]);
    expect(r.outputs).toBe("proposal=\n");
  });

  it("leaves the pull request to a person with the workflow's own token", () => {
    const r = learn({ OCRA_LEARN: "mine", OCRA_OWN_TOKEN: "true" });
    expect(r.args).toEqual(["learn", "mine", "--propose", "--require-review"]);
    expect(r.stdout).toContain("::notice::The pull request is left for a person to merge");
  });

  it("passes on ocra's exit code, and only an address as the output", () => {
    const r = learn({ OCRA_LEARN: "mine", FAKE_EXIT: "2", FAKE_OUT: "proposal=x\nhttps://a b\n" });
    expect(r.status).toBe(2);
    expect(r.outputs).toBe("proposal=\n");
  });

  it("refuses remember off a pull request, and an unknown source", () => {
    const off = learn({ OCRA_LEARN: "remember" });
    expect(off.status).toBe(2);
    expect(off.args).toBeUndefined();
    expect(off.stdout).toContain("remember runs on a comment on a pull request");
    const unknown = learn({ OCRA_LEARN: "import" });
    expect(unknown.status).toBe(2);
    expect(unknown.stdout).toContain("learn must be mine or remember");
  });
});
