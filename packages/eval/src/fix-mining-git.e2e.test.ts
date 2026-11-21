import { scratchRepos } from "@open-cr-agent/test-support";
import { fixCommits } from "@open-cr-agent/vcs-local/internal";
import { afterEach, describe, expect, it } from "vitest";
import { blameFix, introducingCommit } from "./fix-mining-git.js";

const repos = scratchRepos("ocra-fix-mining-");
afterEach(() => repos.removeAll());

const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

describe("fix mining on a real history", () => {
  it("blames the lines a fix rewrote on the commit that introduced them", async () => {
    const repo = repos.create();
    repo.commit("chore: start", {
      "src/sum.ts": lines("export function sum(a, b) {", "  return a + b;", "}"),
    });
    const feature = repo.commit("feat: average", {
      "src/avg.ts": lines(
        "import { sum } from './sum';",
        "export function avg(xs) {",
        "  return xs.reduce(sum, 0) / xs.length;",
        "}",
      ),
    });
    repo.commit("docs: readme", { "README.md": "x\n" });
    const fix = repo.commit("fix: average of an empty list", {
      "src/avg.ts": lines(
        "import { sum } from './sum';",
        "export function avg(xs) {",
        "  return xs.length === 0 ? 0 : xs.reduce(sum, 0) / xs.length;",
        "}",
      ),
      "src/avg.test.ts": "test\n",
    });

    const fixes = await fixCommits(repo.dir, "HEAD");
    expect(fixes).toEqual([{ sha: fix, subject: "fix: average of an empty list" }]);
    const blamed = await blameFix(repo.dir, fixes[0] as (typeof fixes)[number]);
    expect(blamed).toEqual({
      claims: [{ introduced: feature, fix: fixes[0], file: "src/avg.ts", lines: [3, 3] }],
    });
    expect(await introducingCommit(repo.dir, feature)).toMatchObject({
      sha: feature,
      subject: "feat: average",
      changedLines: 4,
    });
  });

  it("names the file as the introducing commit had it when it was renamed since", async () => {
    const repo = repos.create();
    repo.commit("chore: start", { "README.md": "a\n" });
    const feature = repo.commit("feat: half", {
      "src/old.ts": lines("export function half(x) {", "  return x / 3;", "}"),
    });
    repo.git("mv", "src/old.ts", "src/half.ts");
    repo.commit("refactor: rename");
    const fix = repo.commit("fix: halve by two", {
      "src/half.ts": lines("export function half(x) {", "  return x / 2;", "}"),
    });
    const blamed = await blameFix(repo.dir, { sha: fix, subject: "fix: halve by two" });
    expect(blamed).toEqual({
      claims: [
        {
          introduced: feature,
          fix: { sha: fix, subject: "fix: halve by two" },
          file: "src/old.ts",
          lines: [2, 2],
        },
      ],
    });
  });

  it("skips a fix that touches no source file", async () => {
    const repo = repos.create();
    repo.commit("chore: start", { "README.md": "a\n" });
    repo.commit("fix: typo", { "README.md": "b\n" });
    const [fix] = await fixCommits(repo.dir, "HEAD");
    expect(await blameFix(repo.dir, fix as NonNullable<typeof fix>)).toEqual({
      skipped: "no source file",
    });
  });

  it("refuses the root commit as a reviewable change", async () => {
    const repo = repos.create();
    const root = repo.commit("chore: start", { "a.ts": "x\n" });
    expect(await introducingCommit(repo.dir, root)).toBeUndefined();
  });
});
