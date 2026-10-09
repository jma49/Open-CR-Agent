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

  it("passes git neither model keys nor platform tokens, but what it needs", async () => {
    const names = ["OPENAI_API_KEY", "GITHUB_TOKEN", "OCRA_TEST_SECRET"];
    const saved = names.map((name) => process.env[name]);
    for (const name of names) process.env[name] = "sentinel-value-for-the-test";
    try {
      const seen = await git(["-c", "alias.showenv=!env", "showenv"], { cwd: process.cwd() });
      expect(seen).not.toContain("sentinel-value-for-the-test");
      expect(seen).toMatch(/^PATH=/im);
      expect(seen).toMatch(/^LC_ALL=C$/m);
    } finally {
      names.forEach((name, i) => {
        if (saved[i] === undefined) delete process.env[name];
        else process.env[name] = saved[i];
      });
    }
  });

  it("ends a command that does not finish in time", async () => {
    const started = Date.now();
    await expect(
      git(["-c", "alias.nap=!sleep 5", "nap"], { cwd: process.cwd(), timeoutMs: 200 }),
    ).rejects.toThrow("timed out after 0s");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
