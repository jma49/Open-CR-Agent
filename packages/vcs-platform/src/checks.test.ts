import { describe, expect, it } from "vitest";
import { checksOfChange } from "./checks.js";
import type { PlatformCheck } from "./platform.js";

const HEAD = "c".repeat(40);

function platform(checks: Array<[string, PlatformCheck["state"], string?]>, onBase: string[] = []) {
  const read: string[] = [];
  let base = 0;
  return {
    read,
    base: () => base,
    checks: async (sha: string) =>
      sha === HEAD
        ? checks.map(([name, state, log = ""]) => ({
            name,
            state,
            log: async () => {
              read.push(name);
              return log;
            },
          }))
        : [],
    failingOnBase: async () => {
      base += 1;
      return onBase;
    },
  };
}

describe("checksOfChange", () => {
  it("gives the failed checks with the end of their logs, and says when some still run", async () => {
    const forge = platform([
      ["lint", "passed"],
      ["test", "failed", "2026-01-02T03:04:05.123Z \u001b[31mFAIL\u001b[0m a.test.ts\n\n"],
      ["build", "pending"],
    ]);
    expect(await checksOfChange(forge, HEAD)).toEqual({
      pending: true,
      failed: [{ name: "test", log: "FAIL a.test.ts" }],
    });
    expect(forge.read).toEqual(["test"]);
  });

  it("leaves out a check that fails on the base branch too", async () => {
    const forge = platform(
      [
        ["flaky", "failed", "boom"],
        ["test", "failed", "FAIL"],
      ],
      ["flaky"],
    );
    expect(await checksOfChange(forge, HEAD)).toEqual({
      pending: false,
      failed: [{ name: "test", log: "FAIL" }],
    });
    expect(forge.read).toEqual(["test"]);
  });

  it("reads the first three, each name once, and asks nothing of the base when none failed", async () => {
    const many = platform([
      ["a", "failed", "1"],
      ["a", "failed", "again"],
      ["b", "failed", "2"],
      ["c", "failed", "3"],
      ["d", "failed", "4"],
    ]);
    const { failed } = await checksOfChange(many, HEAD);
    expect(failed.map((c) => c.name)).toEqual(["a", "b", "c"]);
    expect(many.read).toEqual(["a", "b", "c"]);

    const green = platform([["test", "passed"]]);
    expect(await checksOfChange(green, HEAD)).toEqual({ pending: false, failed: [] });
    expect(green.base()).toBe(0);
  });
});
