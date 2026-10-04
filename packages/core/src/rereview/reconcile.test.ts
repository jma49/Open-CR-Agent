import { describe, expect, it } from "vitest";
import type { Finding, PriorFinding, PriorReview } from "../domain.js";
import type { CoverageEntry } from "../report/report.js";
import { type ReconcileInput, reconcile, stillOpen } from "./reconcile.js";

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
    provenance: { task: "t1" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
  };
}

function prior(fingerprint: string, file = "a.ts"): PriorFinding {
  return { fingerprint, title: fingerprint, file, severity: "warning", commented: true };
}

function run(
  findings: Finding[],
  review: PriorReview | undefined,
  options: {
    coverage?: CoverageEntry[];
    present?: Record<string, boolean>;
    reported?: string[];
  } = {},
) {
  const input: ReconcileInput = {
    findings,
    reported: new Set([...(options.reported ?? []), ...findings.map((f) => f.fingerprint)]),
    prior: review,
    coverage: options.coverage ?? [{ path: "a.ts", status: "reviewed" }],
    stillPresent: new Map(Object.entries(options.present ?? {})),
  };
  return reconcile(input);
}

const ids = (list: readonly { fingerprint: string }[]) => list.map((f) => f.fingerprint);

describe("reconcile", () => {
  it("leaves findings new when there is no earlier review", () => {
    expect(run([finding("x")], undefined)).toEqual({
      findings: [finding("x")],
      fixed: [],
      notReproduced: [],
      notRechecked: [],
      unchanged: [],
      dismissed: [],
    });
  });

  it("marks repeats unfixed and new ones new", () => {
    const result = run([finding("same"), finding("brand-new")], { findings: [prior("same")] });
    expect(result.findings.map((f) => [f.fingerprint, f.status])).toEqual([
      ["same", "unfixed"],
      ["brand-new", "new"],
    ]);
  });

  it("carries people's replies onto a finding, even one no longer tracked", () => {
    const result = run([finding("same"), finding("dropped-before")], {
      findings: [prior("same")],
      replies: { same: ["Handled by the gateway."], "dropped-before": ["Validated upstream."] },
    });
    expect(result.findings.map((f) => f.replies)).toEqual([
      ["Handled by the gateway."],
      ["Validated upstream."],
    ]);
  });

  it("judges a finding fixed only when its code or its file is gone", () => {
    const result = run(
      [],
      {
        findings: [prior("code-gone"), prior("file-deleted", "old.ts"), prior("code-still-there")],
      },
      { present: { "code-gone": false, "file-deleted": false, "code-still-there": true } },
    );
    expect(ids(result.fixed)).toEqual(["code-gone", "file-deleted"]);
    expect(ids(result.notReproduced)).toEqual(["code-still-there"]);
  });

  it("keeps a finding open when the model quoted other code or chose another category", () => {
    // Either change gives the same issue a new fingerprint: the old one is not
    // reported, but its anchored code is still in the file.
    const result = run(
      [finding("same-issue-new-quote")],
      { findings: [prior("same-issue")] },
      {
        present: { "same-issue": true },
      },
    );
    expect(result.fixed).toEqual([]);
    expect(ids(result.notReproduced)).toEqual(["same-issue"]);
    expect(ids(stillOpen(result))).toEqual(["same-issue"]);
  });

  it("never judges state without a code signature fixed", () => {
    const result = run([], { findings: [prior("legacy")] });
    expect(result.fixed).toEqual([]);
    expect(ids(result.notReproduced)).toEqual(["legacy"]);
  });

  it("keeps findings in files not reviewed this time open", () => {
    const result = run(
      [],
      { findings: [prior("task-failed", "b.ts"), prior("left", "c.ts")] },
      {
        coverage: [{ path: "b.ts", status: "failed" }],
        present: { "task-failed": true },
      },
    );
    expect(ids(result.notRechecked)).toEqual(["task-failed", "left"]);
    expect(ids(stillOpen(result))).toEqual(["task-failed", "left"]);
  });

  it("carries findings in files an incremental review left out as unchanged", () => {
    const result = run(
      [],
      { findings: [prior("kept", "same.ts")] },
      {
        coverage: [{ path: "same.ts", status: "unchanged" }],
        present: { kept: true },
      },
    );
    expect(ids(result.unchanged)).toEqual(["kept"]);
    expect(ids(stillOpen(result))).toEqual(["kept"]);
  });

  it("drops earlier findings that were reported again but not kept", () => {
    const result = run([], { findings: [prior("refuted")] }, { reported: ["refuted"] });
    expect(result).toMatchObject({
      fixed: [],
      notReproduced: [],
      notRechecked: [],
      unchanged: [],
      dismissed: [],
    });
  });

  it("keeps findings a person dismissed quiet unless they got more severe", () => {
    const dismissed = (fingerprint: string) => ({ ...prior(fingerprint), dismissed: true });
    const worse = { ...finding("worse"), severity: "critical" as const };
    const result = run(
      [finding("declined"), worse],
      { findings: [dismissed("declined"), dismissed("worse"), dismissed("quiet")] },
      { present: { quiet: true } },
    );
    expect(result.findings.map((f) => [f.fingerprint, f.status])).toEqual([["worse", "unfixed"]]);
    expect(ids(result.dismissed)).toEqual(["quiet", "declined"]);
    expect(stillOpen(result)).toEqual([]);
  });
});
