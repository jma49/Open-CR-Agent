import { describe, expect, it } from "vitest";
import { CHECK_LIMITS, checkItemId, checkSignature, logTail } from "./checks.js";

describe("logTail", () => {
  it("keeps a log's last lines, without timestamps, terminal sequences and blank lines", () => {
    const log = [
      "2026-11-23T10:00:01.1234567Z \u001b[32m✓\u001b[0m adds",
      "",
      "2026-11-23T10:00:02.0000000Z \u001b[31mFAIL\u001b[0m src/total.test.ts\r",
      "2026-11-23T10:00:02.5000000Z   expected 6 to be 5\u0007",
    ].join("\n");
    expect(logTail(log)).toBe("✓ adds\nFAIL src/total.test.ts\n  expected 6 to be 5");
  });

  it("cuts a long log to its end, by lines and then by characters", () => {
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const tail = logTail(many).split("\n");
    expect(tail).toHaveLength(CHECK_LIMITS.logLines);
    expect(tail.at(-1)).toBe("line 499");
    const wide = logTail(`${"x".repeat(50_000)}\nthe end`);
    expect(wide).toHaveLength(CHECK_LIMITS.logChars);
    expect(wide.endsWith("the end")).toBe(true);
  });

  it("reads the step that failed on GitHub Actions, not the steps that ran after it", () => {
    const after = Array.from({ length: 300 }, (_, n) => `2026-11-23T10:00:09Z cleaning ${n}`);
    const log = [
      "2026-11-23T10:00:01Z ##[group]Run npm ci",
      "2026-11-23T10:00:02Z added 900 packages",
      "2026-11-23T10:00:03Z ##[group]Run npm run typecheck",
      "2026-11-23T10:00:03Z ##[endgroup]",
      "2026-11-23T10:00:04Z src/total.ts(7,3): error TS2322: Type 'string' is not assignable",
      "2026-11-23T10:00:05Z ##[error]Process completed with exit code 2.",
      "2026-11-23T10:00:06Z ##[group]Run actions/upload-artifact@v4",
      "2026-11-23T10:00:07Z Post job cleanup.",
      ...after,
    ].join("\n");
    expect(logTail(log)).toBe(
      [
        "##[group]Run npm run typecheck",
        "##[endgroup]",
        "src/total.ts(7,3): error TS2322: Type 'string' is not assignable",
        "##[error]Process completed with exit code 2.",
      ].join("\n"),
    );
  });

  it("reads the script of a GitLab job, not its after-script", () => {
    const after = Array.from({ length: 300 }, (_, n) => `uploading ${n}`);
    const log = [
      "section_start:1795400000:get_sources\r\u001b[0KFetching changes",
      "section_end:1795400001:get_sources\r\u001b[0K",
      "section_start:1795400002:step_script\r\u001b[0K\u001b[36;1mExecuting the script\u001b[0;m",
      "$ npm test",
      "FAIL src/total.test.ts",
      "section_end:1795400003:step_script\r\u001b[0K",
      "section_start:1795400004:after_script\r\u001b[0K",
      ...after,
      "ERROR: Job failed: exit code 1",
    ].join("\n");
    expect(logTail(log)).toBe("Executing the script\n$ npm test\nFAIL src/total.test.ts");
  });
});

describe("a failed check as a work item", () => {
  const failing = (log: string) => ({ name: "test", log });

  it("is the same item while its first failing line says the same, whatever the numbers", () => {
    const first = failing("✓ adds\nFAIL src/total.test.ts > sums (12 ms)\n  at total.ts:7");
    const again = failing("✓ adds\n✓ more\nFAIL src/total.test.ts > sums (431 ms)\n  at x.ts:9");
    expect(checkSignature(first.log)).toBe("FAIL src/total.test.ts > sums (# ms)");
    expect(checkItemId(again)).toBe(checkItemId(first));
    expect(checkItemId(first)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is another item when another test fails, or under another check's name", () => {
    const sums = failing("FAIL src/total.test.ts > sums");
    expect(checkItemId(failing("FAIL src/total.test.ts > rounds"))).not.toBe(checkItemId(sums));
    expect(checkItemId({ ...sums, name: "lint" })).not.toBe(checkItemId(sums));
  });

  it("falls back to the last line of a log that names no failure", () => {
    expect(checkSignature("building\nexit code 2")).toBe("exit code #");
    expect(checkSignature("")).toBe("");
  });
});
