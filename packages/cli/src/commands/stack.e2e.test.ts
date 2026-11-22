import { join } from "node:path";
import { type ScratchRepo, scratchRepos } from "@open-cr-agent/test-support";
import { afterEach, describe, expect, it } from "vitest";
import { capture } from "../run.fakes.js";
import { stackCommand } from "./stack.js";

const repos = scratchRepos("ocra-stack-");
afterEach(repos.removeAll);

interface Pull {
  number: number;
  state: "open" | "closed";
  merged_at: string | null;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string };
  base: { ref: string };
}

function fakeGitHub() {
  const pulls: Pull[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const { pathname, searchParams } = new URL(url);
    const path = pathname.replace("/repos/o/r", "");
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const method = init?.method ?? "GET";
    if (method === "GET" && path === "/pulls") {
      const head = searchParams.get("head")?.replace(/^o:/, "");
      return Response.json(pulls.filter((p) => p.head.ref === head));
    }
    if (method === "POST" && path === "/pulls") {
      const number = pulls.length + 1;
      const pull: Pull = {
        number,
        state: "open",
        merged_at: null,
        title: body.title,
        body: body.body || null,
        html_url: `https://github.com/o/r/pull/${number}`,
        head: { ref: body.head },
        base: { ref: body.base },
      };
      pulls.push(pull);
      return Response.json(pull, { status: 201 });
    }
    const pull = pulls.find((p) => path === `/pulls/${p.number}`);
    if (method === "PATCH" && pull) {
      if (body.base) pull.base.ref = body.base;
      if (body.body !== undefined) pull.body = body.body;
      return Response.json(pull);
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  const merge = (number: number) => {
    const pull = pulls[number - 1];
    if (pull) Object.assign(pull, { state: "closed", merged_at: "2026-11-22T00:00:00Z" });
  };
  return { pulls, fetch: fetchImpl, merge };
}

function clone(): { r: ScratchRepo; remote: string } {
  const remote = join(repos.create().dir, "remote.git");
  const r = repos.create();
  r.git("init", "-q", "--bare", "-b", "main", remote);
  r.git("remote", "add", "origin", remote);
  r.commit("base", { "app.ts": "one\ntwo\nthree\n" });
  r.git("push", "-q", "origin", "main");
  r.git("fetch", "-q", "origin");
  return { r, remote };
}

async function ocra(r: ScratchRepo, github: ReturnType<typeof fakeGitHub>, ...argv: string[]) {
  const out = capture();
  const err = capture();
  const code = await stackCommand(
    argv,
    { out, err },
    {
      cwd: r.dir,
      env: { GITHUB_TOKEN: "ghs_secret" },
      fetch: github.fetch,
    },
  ).catch((error: Error) => {
    err.write(error.message);
    return 2;
  });
  return { code, out: out.text(), err: err.text() };
}

function stage(r: ScratchRepo, path: string, content: string) {
  r.write(path, content);
  r.git("add", path);
}

describe("ocra stack", () => {
  it("submits a stack, restacks an amended branch, and folds in a squash merge", async () => {
    const { r, remote } = clone();
    const github = fakeGitHub();
    stage(r, "a.ts", "a\n");
    expect((await ocra(r, github, "create", "feat/a", "-m", "feat: a")).out).toBe(
      "feat/a is stacked on main\n",
    );
    stage(r, "b.ts", "b\n");
    await ocra(r, github, "create", "feat/b", "-m", "feat: b");

    const submitted = await ocra(r, github, "--repo", "o/r", "submit");
    expect(submitted.code).toBe(0);
    expect(submitted.out).toBe(
      "feat/a  opened  https://github.com/o/r/pull/1\nfeat/b  opened  https://github.com/o/r/pull/2\n",
    );
    expect(github.pulls.map((p) => [p.title, p.base.ref])).toEqual([
      ["feat: a", "main"],
      ["feat: b", "feat/a"],
    ]);
    expect(github.pulls[1]?.body).toContain("1. #1 feat: a\n2. **#2 feat: b** (this one)");
    expect(r.git("-C", remote, "rev-parse", "feat/b")).toBe(r.git("rev-parse", "feat/b"));

    r.git("switch", "-q", "feat/a");
    r.commit("fix: a", { "a.ts": "a fixed\n" });
    expect((await ocra(r, github, "log")).out).toBe(
      "main\n  feat/a (current)\n    feat/b (needs restack)\n",
    );
    expect((await ocra(r, github, "restack")).out).toBe("Restacked feat/b\n");
    expect(r.git("branch", "--show-current")).toBe("feat/a");
    expect(r.git("show", "feat/b:a.ts")).toBe("a fixed");

    r.git("switch", "-q", "main");
    r.git("merge", "-q", "--squash", "feat/a");
    r.git("commit", "-q", "-m", "feat: a (#1)");
    r.git("push", "-q", "origin", "main");
    r.git("reset", "-q", "--hard", "HEAD~1");
    github.merge(1);
    r.git("switch", "-q", "feat/b");

    const synced = await ocra(r, github, "--repo", "o/r", "sync");
    expect(synced.err).toBe("");
    expect(synced.out).toBe(
      "Merged and deleted: feat/a\nRestacked feat/b; ocra stack submit pushes them\n",
    );
    expect(r.git("branch", "--list", "feat/a")).toBe("");
    expect(r.git("log", "--format=%s", "origin/main..feat/b")).toBe("feat: b");

    const again = await ocra(r, github, "--repo", "o/r", "submit");
    expect(again.out).toBe("feat/b  updated  https://github.com/o/r/pull/2\n");
    expect(github.pulls[1]?.base.ref).toBe("main");
    expect(github.pulls[1]?.body).toContain("1. **#2 feat: b** (this one)");
    expect(r.git("-C", remote, "rev-parse", "feat/b")).toBe(r.git("rev-parse", "feat/b"));
  });

  it("stops a restack at a conflict and picks it up once the rebase is finished", async () => {
    const { r } = clone();
    const github = fakeGitHub();
    await ocra(r, github, "create", "feat/a");
    r.commit("a", { "app.ts": "one\nA\nthree\n" });
    await ocra(r, github, "create", "feat/b");
    r.commit("b", { "app.ts": "one\nB\nthree\n" });
    r.git("switch", "-q", "feat/a");
    r.commit("a again", { "app.ts": "one\nAA\nthree\n" });

    const stopped = await ocra(r, github, "restack");
    expect(stopped.code).toBe(2);
    expect(stopped.err).toContain("Restack stopped at feat/b");
    expect((await ocra(r, github, "restack")).err).toContain("A rebase is in progress");

    r.write("app.ts", "one\nAA B\nthree\n");
    r.git("add", "app.ts");
    r.git("-c", "core.editor=true", "rebase", "--continue");
    expect((await ocra(r, github, "restack")).out).toBe("Every branch is on its parent\n");
    expect((await ocra(r, github, "log")).out).not.toContain("needs restack");
  });

  it("refuses to submit a stack holding a merged branch, before pushing anything", async () => {
    const { r, remote } = clone();
    const github = fakeGitHub();
    stage(r, "a.ts", "a\n");
    await ocra(r, github, "create", "feat/a", "-m", "feat: a");
    await ocra(r, github, "--repo", "o/r", "submit");
    github.merge(1);
    r.commit("more", { "a.ts": "more\n" });
    const refused = await ocra(r, github, "--repo", "o/r", "submit");
    expect(refused.err).toContain("merged; run ocra stack sync first");
    expect(r.git("-C", remote, "rev-parse", "feat/a")).not.toBe(r.git("rev-parse", "feat/a"));
  });

  it("refuses a branch name git would read as an option, and a branch in no stack", async () => {
    const { r } = clone();
    const github = fakeGitHub();
    expect((await ocra(r, github, "create", "--", "-x")).err).toContain("Not a valid branch name");
    expect((await ocra(r, github, "log")).err).toContain("main is in no stack");
  });
});
