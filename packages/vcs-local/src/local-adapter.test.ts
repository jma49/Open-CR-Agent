import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewContext } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter, type LocalTarget } from "./local-adapter.js";

const repos: string[] = [];

function repo(): {
  dir: string;
  run: (...args: string[]) => string;
  write: (p: string, c: string) => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "ocra-local-"));
  repos.push(dir);
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  run("init", "-q", "-b", "main");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  const write = (path: string, content: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  return { dir, run, write };
}

function commitAll(r: ReturnType<typeof repo>, message: string): string {
  r.run("add", "-A");
  r.run("commit", "-q", "-m", message);
  return r.run("rev-parse", "HEAD");
}

async function changes(cwd: string, target: LocalTarget) {
  const diffs = await new LocalGitAdapter({ cwd, target }).getDiff();
  return diffs.map((d) => [d.newPath, d.kind]);
}

afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LocalGitAdapter workspace mode", () => {
  it("includes staged, unstaged and untracked changes", async () => {
    const r = repo();
    r.write("staged.ts", "a\n");
    r.write("unstaged.ts", "a\n");
    commitAll(r, "init");
    r.write("staged.ts", "b\n");
    r.run("add", "staged.ts");
    r.write("unstaged.ts", "b\n");
    r.write("new dir/untracked.ts", "c\n");
    r.write("ignored.log", "x\n");
    r.write(".gitignore", "*.log\n");

    expect(await changes(r.dir, { mode: "workspace" })).toEqual([
      ["staged.ts", "modified"],
      ["unstaged.ts", "modified"],
      [".gitignore", "added"],
      ["new dir/untracked.ts", "added"],
    ]);
  });

  it("works in a repository without commits", async () => {
    const r = repo();
    r.write("first.ts", "a\n");
    expect(await changes(r.dir, { mode: "workspace" })).toEqual([["first.ts", "added"]]);
  });

  it("reports root-relative paths when run from a subdirectory", async () => {
    const r = repo();
    r.write("pkg/a.ts", "a\n");
    commitAll(r, "init");
    r.write("pkg/a.ts", "b\n");
    expect(await changes(join(r.dir, "pkg"), { mode: "workspace" })).toEqual([
      ["pkg/a.ts", "modified"],
    ]);
    const adapter = new LocalGitAdapter({ cwd: join(r.dir, "pkg"), target: { mode: "workspace" } });
    expect(await adapter.repositoryRoot()).toBe(realpathSync(r.dir));
  });

  it("ignores user diff configuration that changes the output format", async () => {
    const r = repo();
    r.write("a.ts", "a\n");
    commitAll(r, "init");
    r.run("config", "diff.noprefix", "true");
    r.run("config", "diff.mnemonicPrefix", "true");
    r.write("a.ts", "b\n");
    expect(await changes(r.dir, { mode: "workspace" })).toEqual([["a.ts", "modified"]]);
  });
});

describe("LocalGitAdapter range mode", () => {
  it("diffs from the merge base so later base commits are excluded", async () => {
    const r = repo();
    r.write("shared.ts", "a\n");
    commitAll(r, "init");
    r.run("switch", "-q", "-c", "feature");
    r.write("feature.ts", "f\n");
    commitAll(r, "feat: add feature");
    r.run("switch", "-q", "main");
    r.write("main-only.ts", "m\n");
    commitAll(r, "main moves on");

    const adapter = new LocalGitAdapter({
      cwd: r.dir,
      target: { mode: "range", from: "main", to: "feature" },
    });
    expect((await adapter.getDiff()).map((d) => d.newPath)).toEqual(["feature.ts"]);
    expect(await adapter.getChangeRequest()).toMatchObject({
      title: "Changes from main to feature",
      description: "- feat: add feature",
    });
  });

  it("rejects refs that look like options", async () => {
    const r = repo();
    r.write("a.ts", "a\n");
    commitAll(r, "init");
    const adapter = new LocalGitAdapter({
      cwd: r.dir,
      target: { mode: "range", from: "--output=/tmp/pwned", to: "main" },
    });
    await expect(adapter.getDiff()).rejects.toThrow("Unknown commit: --output=/tmp/pwned");
  });
});

describe("LocalGitAdapter commit mode", () => {
  it("diffs a commit against its parent and uses its message", async () => {
    const r = repo();
    r.write("a.ts", "a\n");
    commitAll(r, "init");
    r.write("a.ts", "b\n");
    const sha = commitAll(r, "fix: change a\n\nBecause reasons.");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit: sha } });
    expect((await adapter.getDiff()).map((d) => d.newPath)).toEqual(["a.ts"]);
    expect(await adapter.getChangeRequest()).toMatchObject({
      id: sha,
      title: "fix: change a",
      description: "Because reasons.",
    });
  });

  it("diffs a root commit against the empty tree", async () => {
    const r = repo();
    r.write("a.ts", "a\n");
    const sha = commitAll(r, "init");
    expect(await changes(r.dir, { mode: "commit", commit: sha })).toEqual([["a.ts", "added"]]);
  });
});

describe("LocalGitAdapter.readFile", () => {
  it("reads the working tree in workspace mode and the head commit otherwise", async () => {
    const r = repo();
    r.write("a.ts", "committed\n");
    const sha = commitAll(r, "init");
    r.write("a.ts", "edited\n");

    const workspace = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    const commit = new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit: sha } });
    expect(await workspace.readFile("a.ts")).toBe("edited\n");
    expect(await commit.readFile("a.ts")).toBe("committed\n");
    expect(await commit.readFile("missing.ts")).toBeUndefined();
    expect(await workspace.readFile("missing.ts")).toBeUndefined();
  });

  it("refuses paths outside the repository", async () => {
    const r = repo();
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.readFile("../outside.txt")).toBeUndefined();
    expect(await adapter.readFile("/etc/passwd")).toBeUndefined();
  });

  it("refuses symlinks that point outside the repository", async () => {
    const r = repo();
    const outside = mkdtempSync(join(tmpdir(), "ocra-outside-"));
    repos.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    symlinkSync(join(outside, "secret.txt"), join(r.dir, "link.txt"));
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.readFile("link.txt")).toBeUndefined();
  });

  it("reads files whose names start with two dots", async () => {
    const r = repo();
    r.write("..notes.md", "ok\n");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.readFile("..notes.md")).toBe("ok\n");
  });
});

describe("LocalGitAdapter.searchCode", () => {
  it("searches the working tree, including untracked files, as literal text", async () => {
    const r = repo();
    r.write("a.ts", "call(x);\nother();\n");
    commitAll(r, "init");
    r.write("dir/b.ts", "// call(x);\n");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.searchCode("call(x)")).toEqual([
      { path: "a.ts", line: 1, text: "call(x);" },
      { path: "dir/b.ts", line: 1, text: "// call(x);" },
    ]);
    expect(await adapter.searchCode("missing")).toEqual([]);
  });

  it("searches the reviewed commit rather than the working tree", async () => {
    const r = repo();
    r.write("a.ts", "committed();\n");
    const sha = commitAll(r, "init");
    r.write("a.ts", "edited();\n");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "commit", commit: sha } });
    expect(await adapter.searchCode("committed")).toEqual([
      { path: "a.ts", line: 1, text: "committed();" },
    ]);
    expect(await adapter.searchCode("edited")).toEqual([]);
  });

  it("treats option-like input as a search literal", async () => {
    const r = repo();
    r.write("a.ts", "--output=x\n");
    const adapter = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    expect(await adapter.searchCode("--output=x")).toEqual([
      { path: "a.ts", line: 1, text: "--output=x" },
    ]);
  });
});

describe("LocalGitAdapter behind the review context", () => {
  it("does not let agents read an ignored .env or .git/config", async () => {
    const r = repo();
    r.write(".gitignore", ".env\n");
    r.write(".env", "API_KEY=supersecret\n");
    r.write("a.ts", "a\n");
    commitAll(r, "init");
    r.write("a.ts", "b\n");
    const vcs = new LocalGitAdapter({ cwd: r.dir, target: { mode: "workspace" } });
    const context = reviewContext(vcs, await vcs.getDiff());

    await expect(context.readFile(".env")).rejects.toThrow("not allowed");
    await expect(context.readFile(".git/config")).rejects.toThrow("not allowed");
    await expect(context.readFile("a.ts")).resolves.toBe("b\n");
  });
});
