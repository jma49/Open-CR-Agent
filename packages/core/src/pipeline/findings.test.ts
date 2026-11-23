import { describe, expect, it } from "vitest";
import { limiter, mapWithConcurrency } from "../agent/pool.js";
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

describe("limiter", () => {
  it("runs jobs as they are added, a few at a time, in order", async () => {
    const limited = limiter(2);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const job = (n: number) => async () => {
      started.push(n);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return n;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map((n) => limited(job(n))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(started).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("frees a place when a job fails", async () => {
    const limited = limiter(1);
    await expect(limited(() => Promise.reject(new Error("no")))).rejects.toThrow("no");
    await expect(limited(async () => "next")).resolves.toBe("next");
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

  it("keeps the copy verification already has among equally severe ones", () => {
    const first = { fingerprint: "f", id: "1", severity: "warning" } as Finding;
    const checked = { ...first, id: "2" } as Finding;
    const worse = { ...first, id: "3", severity: "critical" } as Finding;
    const has = new Set(["2"]);
    expect(dedupeFindings([first, checked], has).map((f) => f.id)).toEqual(["2"]);
    expect(dedupeFindings([checked, first], has).map((f) => f.id)).toEqual(["2"]);
    expect(dedupeFindings([checked, worse], has).map((f) => f.id)).toEqual(["3"]);
  });
});
