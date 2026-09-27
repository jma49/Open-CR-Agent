import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalGitAdapter, MAX_READ_BYTES } from "./local-adapter.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("LocalGitAdapter reads", () => {
  it("reads at most MAX_READ_BYTES of a file, in the working tree and at a commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-big-"));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, "big.json"), "a".repeat(MAX_READ_BYTES + 1_000_000));
    git("add", "-A");
    git("commit", "-q", "-m", "big");
    const head = git("rev-parse", "HEAD").trim();

    const workspace = new LocalGitAdapter({ cwd: dir, target: { mode: "workspace" } });
    expect((await workspace.readFile("big.json"))?.length).toBe(MAX_READ_BYTES);
    const commit = new LocalGitAdapter({ cwd: dir, target: { mode: "commit", commit: head } });
    expect((await commit.readFile("big.json"))?.length).toBe(MAX_READ_BYTES);
  });
});
