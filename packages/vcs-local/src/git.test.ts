import { describe, expect, it } from "vitest";
import { GitError, git } from "./git.js";

describe("git", () => {
  it("survives git exiting before it reads stdin", async () => {
    const input = "x".repeat(8 * 1024 * 1024);
    await expect(git(["--version"], { cwd: process.cwd(), input })).resolves.toMatch(
      /^git version/,
    );
  });

  it("reports failing commands with their exit code", async () => {
    const failure = git(["rev-parse", "--verify", "no-such-ref"], { cwd: process.cwd() });
    await expect(failure).rejects.toBeInstanceOf(GitError);
    await expect(failure).rejects.toMatchObject({ exitCode: 128 });
  });

  it("accepts expected non-zero exit codes", async () => {
    const out = git(["rev-parse", "--verify", "--quiet", "no-such-ref"], {
      cwd: process.cwd(),
      okExitCodes: [1],
    });
    await expect(out).resolves.toBe("");
  });
});
