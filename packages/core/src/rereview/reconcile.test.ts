import { describe, expect, it } from "vitest";
import type { Finding, PriorFinding } from "../domain.js";
import { reconcile } from "./reconcile.js";

function finding(fingerprint: string, file = "a.ts"): Finding {
  return {
    id: fingerprint,
    fingerprint,
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    file,
    existingCode: "x",
    title: fingerprint,
    body: "b",
    evidence: [],
    anchor: { method: "hunk", inDiff: true },
    status: "new",
  };
}

function prior(fingerprint: string, file: string): PriorFinding {
  return { fingerprint, title: fingerprint, file, severity: "warning", commented: true };
}

describe("reconcile", () => {
  it("leaves findings new when there is no earlier review", () => {
    expect(reconcile([finding("x")], undefined, [])).toEqual({
      findings: [finding("x")],
      fixed: [],
      notRechecked: [],
    });
  });

  it("marks repeats unfixed and splits vanished findings by whether their file was rechecked", () => {
    const result = reconcile(
      [finding("same"), finding("brand-new")],
      {
        findings: [
          prior("same", "a.ts"),
          prior("gone", "a.ts"),
          prior("file-left-change", "old.ts"),
          prior("task-failed", "b.ts"),
        ],
      },
      [
        { path: "a.ts", status: "reviewed" },
        { path: "b.ts", status: "failed" },
      ],
    );
    expect(result.findings.map((f) => [f.fingerprint, f.status])).toEqual([
      ["same", "unfixed"],
      ["brand-new", "new"],
    ]);
    expect(result.fixed.map((f) => f.fingerprint)).toEqual(["gone", "file-left-change"]);
    expect(result.notRechecked.map((f) => f.fingerprint)).toEqual(["task-failed"]);
  });
});
