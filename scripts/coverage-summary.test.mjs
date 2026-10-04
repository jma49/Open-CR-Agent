import { describe, expect, it } from "vitest";
import { packageOf, renderCoverage } from "./coverage-summary.mjs";

const m = (covered, total) => ({ covered, total, skipped: 0, pct: 0 });
const metrics = (covered, total) => ({
  lines: m(covered, total),
  statements: m(covered, total),
  functions: m(covered, total),
  branches: m(covered, total),
});

describe("coverage summary", () => {
  it("finds the package of a file on any platform", () => {
    expect(packageOf("/w/repo/packages/core/src/a.ts")).toBe("core");
    expect(packageOf("D:\\w\\packages\\cli\\src\\a.ts")).toBe("cli");
    expect(packageOf("/w/scripts/a.mjs")).toBeUndefined();
  });

  it("sums files per package under the total", () => {
    const table = renderCoverage({
      total: metrics(3, 4),
      "/r/packages/core/src/a.ts": metrics(1, 2),
      "/r/packages/core/src/b.ts": metrics(1, 1),
      "/r/packages/cli/src/c.ts": metrics(1, 1),
      "/r/packages/eval/src/empty.ts": metrics(0, 0),
    });
    expect(table.split("\n").slice(2, 6)).toEqual([
      "| **total** | **75.0%** | **75.0%** | **75.0%** | **75.0%** |",
      "| cli | 100.0% | 100.0% | 100.0% | 100.0% |",
      "| core | 66.7% | 66.7% | 66.7% | 66.7% |",
      "| eval | - | - | - | - |",
    ]);
  });
});
