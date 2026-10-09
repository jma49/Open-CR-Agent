import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTaskSpec } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps, removeRepos, repoWithChange } from "../../run.fakes.js";
import { run } from "../../run.js";

// The checkout may be someone else's change: a link committed under the name
// passed to --output must not carry the report to a file outside it.
const outside: string[] = [];
afterEach(() => {
  removeRepos();
  for (const dir of outside.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function elsewhere(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-outside-"));
  outside.push(dir);
  return dir;
}

function counting() {
  const calls = { count: 0 };
  const script = async function* (spec: AgentTaskSpec) {
    calls.count += 1;
    yield { type: "done" as const, taskId: spec.taskId };
  };
  return { calls, script };
}

async function review(cwd: string, args: string[], script = counting().script) {
  const err = capture();
  const code = await run(
    ["review", "--format", "json", ...args],
    capture(),
    err,
    deps(cwd, script),
  );
  return { code, err: err.text() };
}

describe("ocra review --output", () => {
  it("refuses a link at the output path, before reviewing, and leaves its target alone", async () => {
    const cwd = repoWithChange();
    const victim = join(elsewhere(), "victim.txt");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, join(cwd, "r.json"));
    const { calls, script } = counting();

    const { code, err } = await review(cwd, ["--output", "r.json"], script);

    expect(code).toBe(2);
    expect(err).toContain("[ACCESS_DENIED]");
    expect(err).toContain("symbolic link");
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(calls.count).toBe(0);
  });

  it("refuses a dangling link, so nothing is created where it points", async () => {
    const cwd = repoWithChange();
    const target = join(elsewhere(), "made.json");
    symlinkSync(target, join(cwd, "r.json"));

    expect((await review(cwd, ["--output", "r.json"])).code).toBe(2);
    expect(existsSync(target)).toBe(false);
  });

  it("refuses a linked directory on the way to the output", async () => {
    const cwd = repoWithChange();
    const dir = elsewhere();
    symlinkSync(dir, join(cwd, "out"));

    expect((await review(cwd, ["--output", "out/r.json"])).code).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses a link for the plan too", async () => {
    const cwd = repoWithChange();
    const victim = join(elsewhere(), "victim.txt");
    writeFileSync(victim, "keep\n");
    symlinkSync(victim, join(cwd, "plan.json"));

    expect((await review(cwd, ["--plan", "--output", "plan.json"])).code).toBe(2);
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
  });

  it("follows a link that leads to the repository, since the checkout cannot plant it", async () => {
    const cwd = repoWithChange();
    const alias = join(elsewhere(), "alias");
    symlinkSync(cwd, alias);

    expect((await review(cwd, ["--output", join(alias, "r.json")])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"))).toMatchObject({ findings: [] });
  });

  it("replaces an existing report whole and leaves no temporary file", async () => {
    const cwd = repoWithChange();
    mkdirSync(join(cwd, "out"));
    writeFileSync(
      join(cwd, "out", "r.json"),
      "old report that is longer than the new one".repeat(99),
    );

    expect((await review(cwd, ["--output", "out/r.json"])).code).toBe(0);
    expect(JSON.parse(readFileSync(join(cwd, "out", "r.json"), "utf8"))).toMatchObject({
      findings: [],
    });
    expect(readdirSync(join(cwd, "out"))).toEqual(["r.json"]);
  });
});
