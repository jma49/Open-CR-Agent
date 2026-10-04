import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../agent/pool.js";
import type { Finding } from "../domain.js";
import { dedupeFindings, fingerprint, toFinding } from "./findings.js";

describe("fingerprint", () => {
  it("ignores whitespace differences in the quoted code", () => {
    expect(fingerprint("c", "a.ts", "if (x) {\n  y();\n}")).toBe(
      fingerprint("c", "a.ts", "if (x)   {\ny();\n\n}"),
    );
  });

  it("changes with category, file or code", () => {
    const base = fingerprint("c", "a.ts", "x");
    expect(fingerprint("d", "a.ts", "x")).not.toBe(base);
    expect(fingerprint("c", "b.ts", "x")).not.toBe(base);
    expect(fingerprint("c", "a.ts", "y")).not.toBe(base);
  });
});

describe("toFinding", () => {
  const reported = {
    category: "correctness",
    severity: "warning" as const,
    file: "a.ts",
    existingCode: "x",
    title: "t",
    body: "b",
    evidence: [],
  };
  const anchor = { file: "a.ts", method: "hunk" as const, inDiff: true };

  it("records which task and model reported the finding", () => {
    const f = toFinding(reported, "correctness", { task: "t1", model: "p/m" }, anchor);
    expect(f.provenance).toEqual({ task: "t1", model: "p/m" });
    expect(f.reviewer).toBe("correctness");
  });

  it("records the task alone when the runtime named no model", () => {
    const f = toFinding(reported, "correctness", { task: "t1" }, anchor);
    expect(f.provenance).toEqual({ task: "t1" });
  });
});

describe("mapWithConcurrency", () => {
  it("never runs more than the limit at once and keeps result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([30, 10, 20, 5, 1], 2, async (ms) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, ms));
      active -= 1;
      return ms * 2;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([60, 20, 40, 10, 2]);
  });
});

describe("dedupeFindings", () => {
  it("keeps the most severe copy whole, so its text matches its severity", () => {
    const base = { fingerprint: "f", file: "a.ts" } as Finding;
    const warning = { ...base, id: "1", severity: "warning", title: "Slow loop" } as Finding;
    const critical = {
      ...base,
      id: "2",
      severity: "critical",
      title: "Crash on empty input",
    } as Finding;
    const other = { ...base, fingerprint: "g", id: "3", severity: "suggestion" } as Finding;
    expect(
      dedupeFindings([warning, critical, other]).map((f) => [f.id, f.severity, f.title]),
    ).toEqual([
      ["2", "critical", "Crash on empty input"],
      ["3", "suggestion", undefined],
    ]);
  });
});
