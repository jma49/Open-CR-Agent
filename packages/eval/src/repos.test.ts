import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exec } from "./exec.js";
import { GIT_ENV } from "./repos.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GIT_ENV", () => {
  it("checks out LFS-tracked files when the filter is declared but git-lfs is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-lfs-"));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "T");
    writeFileSync(join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    writeFileSync(join(dir, "a.bin"), "pointer\n");
    const quiet = { cwd: dir, stdio: "ignore" as const };
    execFileSync("git", ["config", "filter.lfs.required", "false"], quiet);
    execFileSync("git", ["add", "-A"], quiet);
    execFileSync("git", ["commit", "-q", "-m", "init"], quiet);
    const head = git("rev-parse", "HEAD").trim();
    rmSync(join(dir, "a.bin"));
    // The situation on a machine with LFS configured but not installed.
    git("config", "filter.lfs.process", "git-lfs-not-installed filter-process");
    git("config", "filter.lfs.required", "true");

    const plain = await exec("git", ["checkout", "--quiet", "--force", "--detach", head], {
      cwd: dir,
    });
    expect(plain.exitCode).not.toBe(0);
    const fixed = await exec("git", ["checkout", "--quiet", "--force", "--detach", head], {
      cwd: dir,
      env: GIT_ENV,
    });
    expect(fixed.exitCode).toBe(0);
    // The raw blob: the file itself, or an LFS pointer where git-lfs is installed.
    expect(existsSync(join(dir, "a.bin"))).toBe(true);
  });
});
