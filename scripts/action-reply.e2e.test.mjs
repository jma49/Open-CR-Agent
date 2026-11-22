import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The Action's reply step, run as the runner runs it: action.yml's `run:`
// in a step file under `bash -eo pipefail`, against a fake ocra that records
// its arguments and exits with FAKE_EXIT.
const root = fileURLToPath(new URL("..", import.meta.url));
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;
/** @type {string[]} */
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** The one-line `run:` of action.yml's Reply step. */
function replyRun() {
  const lines = readFileSync(join(root, "action.yml"), "utf8").split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Reply");
  const run = lines.slice(step).find((line) => line.trimStart().startsWith("run: "));
  if (step < 0 || !run) throw new Error("action.yml has no Reply step with a one-line run:");
  return run.trimStart().slice("run: ".length);
}

const FAKE_OCRA = `import { writeFileSync } from "node:fs";
writeFileSync(process.env.FAKE_ARGS, JSON.stringify(process.argv.slice(2)));
process.exit(Number(process.env.FAKE_EXIT ?? 0));
`;

/** @param {Record<string, string>} env */
function reply(env) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-action-reply-"));
  dirs.push(dir);
  const work = join(dir, "work");
  mkdirSync(work);
  writeFileSync(join(dir, "ocra.mjs"), FAKE_OCRA);
  const step = join(dir, "step.sh");
  writeFileSync(step, `${replyRun()}\n`);
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", step], {
    cwd: work,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      GITHUB_ACTION_PATH: root,
      OCRA_MAIN: join(dir, "ocra.mjs"),
      FAKE_ARGS: join(dir, "args.json"),
      ...env,
    },
  });
  /** @type {string[] | undefined} */
  let args;
  try {
    args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
  } catch {}
  return { status: result.status, stdout: result.stdout, args };
}

describe.skipIf(!hasBash)("the Action's reply step", () => {
  it("answers a conversation comment, and a line comment with --inline", () => {
    const plain = reply({ OCRA_PR: "7", OCRA_COMMENT: "41", OCRA_INLINE: "false" });
    expect(plain.status).toBe(0);
    expect(plain.args).toEqual(["reply", "--pr", "7", "--comment", "41"]);
    const inline = reply({
      OCRA_PR: "7",
      OCRA_COMMENT: "42",
      OCRA_INLINE: "true",
      OCRA_ARGS: "--repo o/r",
    });
    expect(inline.args).toEqual([
      "reply",
      "--pr",
      "7",
      "--comment",
      "42",
      "--inline",
      "--repo",
      "o/r",
    ]);
  });

  it("passes on ocra's exit code", () => {
    expect(reply({ OCRA_PR: "7", OCRA_COMMENT: "41", FAKE_EXIT: "2" }).status).toBe(2);
  });

  it("refuses to run off a comment on a pull request", () => {
    const r = reply({ OCRA_COMMENT: "41" });
    expect(r.status).toBe(2);
    expect(r.args).toBeUndefined();
    expect(r.stdout).toContain("reply runs on a comment on a pull request");
  });
});
