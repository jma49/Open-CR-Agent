import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { filesChangedSince } from "./history.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "ocra-history-"));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  const commit = (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit };
}

describe("filesChangedSince", () => {
  it("lists the files changed between an ancestor and a descendant", async () => {
    const r = repo();
    const one = r.commit({ "a.ts": "1", "b.ts": "1" });
    const two = r.commit({ "b.ts": "2", "c d.ts": "new" });
    expect(await filesChangedSince(r.dir, one, two)).toEqual({ files: ["b.ts", "c d.ts"] });
    expect(await filesChangedSince(r.dir, two, two)).toEqual({ files: [] });
  });

  it("gives a reason for rewritten history, missing commits and non-ids", async () => {
    const r = repo();
    const base = r.commit({ "a.ts": "1" });
    const old = r.commit({ "a.ts": "2" });
    r.git("reset", "-q", "--hard", base);
    const rewritten = r.commit({ "a.ts": "3" });
    expect(await filesChangedSince(r.dir, old, rewritten)).toEqual({
      reason: `commit ${old.slice(0, 7)} is not an ancestor of the new head (force-push or rebase)`,
    });
    const missing = "e".repeat(40);
    expect(await filesChangedSince(r.dir, missing, rewritten)).toEqual({
      reason: "commit eeeeeee is not available",
    });
    expect(await filesChangedSince(r.dir, "--output=x", rewritten)).toEqual({
      reason: "not a commit id",
    });
  });
});
