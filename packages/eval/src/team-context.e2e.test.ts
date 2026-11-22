import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLearning } from "@open-cr-agent/cli/internal";
import { scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_REPORT_JS } from "./fake-ocra.fakes.js";
import type { CaseLearning, Instance, TeamContext } from "./instance.js";
import { runInstances } from "./runner.js";
import { learningFile, rewriteCommit, withTeamContext } from "./team-context.js";

const repos = scratchRepos("ocra-team-");
const scratch: string[] = [];
afterEach(async () => {
  await repos.removeAll();
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

const learning: CaseLearning = {
  name: "retry-budget",
  title: "Retries share one budget per run",
  paths: ["src/"],
  symbols: [],
  keywords: ["retry"],
  critical: false,
  source: { kind: "fix-commit", ref: "abc1234" },
  created: "2026-01-01",
  body: "Every retry loop draws on the run's budget, never its own.",
};

function caseRepo() {
  const repo = repos.create();
  const baseCommit = repo.commit("base", { "src/a.ts": "export const a = 1;\n" });
  repo.commit("first change", { "src/a.ts": "export const a = 2;\n" });
  repo.git("checkout", "-q", "-b", "side", `${baseCommit}`);
  repo.commit("side change", { "src/b.ts": "export const b = 1;\n" });
  repo.git("checkout", "-q", "main");
  repo.git("merge", "-q", "--no-edit", "side");
  const headCommit = repo.git("rev-parse", "HEAD");
  const instance = (team: TeamContext | undefined): Instance => ({
    id: "case",
    repo: "o/r",
    prUrl: "",
    language: "TypeScript",
    prCategory: "golden",
    baseCommit,
    headCommit,
    changeLines: 0,
    references: [],
    golden: {
      tier: "full",
      clean: true,
      forbid: [],
      adjudicated: [],
      claims: [],
      minSeverity: [],
      alternates: [],
      ...(team ? { team } : {}),
    },
  });
  return { repo, baseCommit, headCommit, instance };
}

describe("withTeamContext", () => {
  it("leaves a case without team context as it is", async () => {
    const { repo, instance } = caseRepo();
    const plain = instance(undefined);
    expect(await withTeamContext(repo.dir, plain, ["--x"])).toEqual({
      target: plain,
      args: ["--x"],
    });
  });

  it("puts the learnings in the base and keeps the diff and the subjects", async () => {
    const { repo, baseCommit, headCommit, instance } = caseRepo();
    const refs = repo.git("for-each-ref");
    const { target } = await withTeamContext(repo.dir, instance({ learnings: [learning] }), []);
    expect(target.baseCommit).not.toBe(baseCommit);
    expect(repo.git("show", `${target.baseCommit}:.ocra/learnings/retry-budget.md`)).toBe(
      learningFile(learning).trim(),
    );
    expect(repo.git("diff", target.baseCommit, target.headCommit)).toBe(
      repo.git("diff", baseCommit, headCommit),
    );
    const subjects = (from: string, to: string) =>
      repo.git("log", "--format=- %s", `${repo.git("merge-base", from, to)}..${to}`);
    expect(subjects(target.baseCommit, target.headCommit)).toBe(subjects(baseCommit, headCommit));
    expect(repo.git("for-each-ref")).toBe(refs);
    expect(repo.git("status", "--porcelain")).toBe("");

    const again = await withTeamContext(repo.dir, instance({ learnings: [learning] }), []);
    expect(again.target).toEqual(target);
  });

  it("writes learnings that ocra reads", () => {
    const parsed = parseLearning(learningFile(learning));
    expect(parsed).toEqual({
      frontmatter: {
        title: learning.title,
        paths: learning.paths,
        symbols: [],
        keywords: ["retry"],
        critical: false,
        source: learning.source,
        created: "2026-01-01",
      },
      body: learning.body,
    });
  });

  it("refuses a range that already holds learnings", async () => {
    const { repo, instance } = caseRepo();
    repo.commit("own learnings", { ".ocra/learnings/x.md": "x" });
    const owned = {
      ...instance({ learnings: [learning] }),
      headCommit: repo.git("rev-parse", "HEAD"),
    };
    await expect(withTeamContext(repo.dir, owned, [])).rejects.toThrow(
      "already holds .ocra/learnings",
    );
  });

  it("names the project documents in a copy of the configuration", async () => {
    const { repo, instance } = caseRepo();
    const dir = await mkdtemp(join(tmpdir(), "ocra-team-config-"));
    scratch.push(dir);
    const config = join(dir, "config.json");
    await writeFile(config, JSON.stringify({ maxTasks: 5 }));
    const { args } = await withTeamContext(
      repo.dir,
      instance({ projectDocs: ["docs/design.md"] }),
      ["--config", config, "--seed", "1"],
    );
    expect(args.slice(0, 2)).toEqual(["--seed", "1"]);
    expect(args[2]).toBe("--config");
    expect(JSON.parse(readFileSync(args[3] ?? "", "utf8"))).toEqual({
      maxTasks: 5,
      projectDocs: ["docs/design.md"],
    });
  });
});

describe("a run with team context", () => {
  it("reviews the replayed range with the case's configuration", async () => {
    const { repo, instance } = caseRepo();
    const runDir = await mkdtemp(join(tmpdir(), "ocra-team-run-"));
    scratch.push(runDir);
    const script = join(runDir, "fake-ocra.mjs");
    await writeFile(
      script,
      `import { writeFileSync } from "node:fs";
${FAKE_REPORT_JS}
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(join(runDir, "args.json"))}, JSON.stringify(args));
writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify(report({ tasks: [task("correctness-1", "completed")] })));
`,
    );
    const team = instance({ learnings: [learning], projectDocs: ["docs/design.md"] });
    const [result] = await runInstances([team], {
      runDir,
      reposDir: repo.dir,
      command: [process.execPath, script],
      timeoutMs: 30_000,
      prepare: async () => repo.dir,
      log: () => {},
    });
    expect(result).toMatchObject({ status: "reviewed" });
    const args: string[] = JSON.parse(readFileSync(join(runDir, "args.json"), "utf8"));
    const { target } = await withTeamContext(repo.dir, team, []);
    expect(args[args.indexOf("--from") + 1]).toBe(target.baseCommit);
    expect(args[args.indexOf("--to") + 1]).toBe(target.headCommit);
    const config = JSON.parse(readFileSync(args[args.indexOf("--config") + 1] ?? "", "utf8"));
    expect(config).toEqual({ projectDocs: ["docs/design.md"] });
  });
});

describe("rewriteCommit", () => {
  it("swaps the tree and replayed parents and drops a signature", () => {
    const object = [
      "tree aaa",
      "parent p1",
      "parent p2",
      "author A <a@x> 1 +0000",
      "committer A <a@x> 1 +0000",
      "gpgsig -----BEGIN PGP SIGNATURE-----",
      " line",
      " -----END PGP SIGNATURE-----",
      "",
      "subject",
      "",
      " indented body",
      "",
    ].join("\n");
    expect(rewriteCommit(object, "bbb", new Map([["p1", "q1"]]))).toBe(
      [
        "tree bbb",
        "parent q1",
        "parent p2",
        "author A <a@x> 1 +0000",
        "committer A <a@x> 1 +0000",
        "",
        "subject",
        "",
        " indented body",
        "",
      ].join("\n"),
    );
  });
});
