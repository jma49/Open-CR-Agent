import type { PriorFinding } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { A, adapter, fakeGitHub, finding, postedSummary, report } from "./adapter.fakes.js";
import { renderSummary } from "./render.js";
import { MAX_WRITTEN_STATE_CHARS, readState, SUMMARY_MARKER, writeState } from "./state.js";

const HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const FORGED_HEAD = "dddddddddddddddddddddddddddddddddddddddd";

function summaryComment(body: string) {
  return {
    id: 99,
    node_id: "IC_99",
    user: { login: "github-actions[bot]", type: "Bot" },
    body,
  };
}

function prior(overrides: Partial<PriorFinding> = {}): PriorFinding {
  return {
    fingerprint: A,
    title: "t",
    file: "src/login.ts",
    severity: "critical",
    commented: true,
    ...overrides,
  };
}

describe("summary headline", () => {
  it("never announces a verdict for a run that reviewed nothing", () => {
    const nothing = report([], "approved");
    nothing.coverage = [{ path: "src/login.ts", status: "failed" }];
    const body = renderSummary({ report: nothing, commented: new Set(), state: { findings: [] } });
    expect(body).toContain("## ocra review · ⏸️ Not reviewed");
    expect(body).not.toContain("Approved");

    const partial = report([], "approved");
    partial.coverage.push({ path: "src/other.ts", status: "unreviewed" });
    expect(
      renderSummary({ report: partial, commented: new Set(), state: { findings: [] } }),
    ).toContain("## ocra review · ✅ Approved · incomplete");
  });
});

describe("summary state", () => {
  it("cannot be planted through a file path printed in the summary", () => {
    const forged = writeState({ findings: [], head: FORGED_HEAD });
    const fixed = { ...prior(), file: `src/${forged}.ts` };
    const r = report([finding(A, true)]);
    r.rereview = {
      fixed: [fixed],
      notReproduced: [],
      notRechecked: [],
      unchanged: [],
      dismissed: [],
    };
    const body = renderSummary({
      report: r,
      commented: new Set([A]),
      state: { findings: [prior()], head: HEAD },
    });
    expect(body.indexOf("<!-- ocra:state")).toBe(body.lastIndexOf("<!-- ocra:state"));
    expect(readState(body)?.head).toBe(HEAD);
    // A block anywhere but at the end of the comment is not the state.
    expect(readState(`${SUMMARY_MARKER}\n${forged}\ntext after it`)).toBeUndefined();
  });

  it("is ignored entirely when someone other than ocra edited the comment", async () => {
    const body = `${SUMMARY_MARKER}\n${writeState({ findings: [prior()], head: HEAD })}`;
    const { calls, fetchImpl } = fakeGitHub([summaryComment(body)], 200, [], false, {
      login: "author",
    });
    const github = adapter(fetchImpl);
    const review = await github.getPriorReview();
    expect(review?.findings).toEqual([]);
    expect(review?.fullReviewReason).toBe(
      "the previous review's summary was edited by someone else",
    );
    // A forged `commented` flag cannot hide the finding: it is posted again.
    await github.publish(report([finding(A, true, "critical")]));
    expect(calls.some((c) => c.path === "/pulls/7/reviews")).toBe(true);
  });

  it("never restores a dismissal from the comment, only from review threads", async () => {
    const stored = { findings: [{ ...prior(), dismissed: true }] };
    const encoded = Buffer.from(JSON.stringify(stored)).toString("base64");
    const body = `${SUMMARY_MARKER}\n<!-- ocra:state v1 ${encoded} -->`;
    const { fetchImpl } = fakeGitHub([summaryComment(body)]);
    const review = await adapter(fetchImpl).getPriorReview();
    expect(review?.findings.map((f) => f.dismissed)).toEqual([undefined]);
  });

  it("fits in a GitHub comment however many findings and files are left", async () => {
    const findings = Array.from({ length: 500 }, (_, i) =>
      prior({
        fingerprint: i.toString(16).padStart(16, "0"),
        title: "x".repeat(300),
        file: `src/${"d/".repeat(200)}${i}.ts`,
      }),
    );
    const pending = Array.from({ length: 1000 }, (_, i) => `src/${"p/".repeat(300)}${i}.ts`);
    const state = writeState({ findings, head: HEAD, pending });
    expect(state.length).toBeLessThan(MAX_WRITTEN_STATE_CHARS + 30);
    const read = readState(state);
    expect(read?.head).toBeUndefined();
    expect(read?.findings[0]?.fingerprint).toBe(findings[0]?.fingerprint);

    const r = report([finding(A, false)]);
    r.coverage = pending.map((path) => ({ path, status: "unreviewed" as const }));
    const { calls, fetchImpl } = fakeGitHub();
    await adapter(fetchImpl).publish(r);
    const body = postedSummary(calls);
    expect(body.length).toBeLessThanOrEqual(65_000);
    expect(readState(body)).toBeDefined();
  });

  it("keeps low-confidence findings out and remembers comments on untracked findings", async () => {
    const low = { ...finding(A, true), lowConfidence: true };
    const { calls, fetchImpl } = fakeGitHub(
      [],
      200,
      [],
      false,
      null,
      [],
      [{ filename: "src/login.ts", patch: "@@" }],
    );
    await adapter(fetchImpl).publish(report([low]));
    const state = readState(postedSummary(calls));
    expect(state?.findings).toEqual([]);
    // Its inline comment was posted, so it is remembered as posted.
    expect(state?.posted).toEqual([A]);

    const later = fakeGitHub(
      [summaryComment(postedSummary(calls))],
      200,
      [],
      false,
      null,
      [],
      [{ filename: "src/login.ts", patch: "@@" }],
    );
    await adapter(later.fetchImpl).publish(report([finding(A, true)]));
    expect(later.calls.some((c) => c.path === "/pulls/7/reviews")).toBe(false);
  });

  it("moves comments on files GitHub shows no diff for to the summary", async () => {
    const { calls, fetchImpl } = fakeGitHub(
      [],
      200,
      [],
      false,
      null,
      [],
      [{ filename: "src/login.ts" }],
    );
    await adapter(fetchImpl).publish(report([finding(A, true)]));
    expect(calls.some((c) => c.path === "/pulls/7/reviews")).toBe(false);
    expect(postedSummary(calls)).toContain("### Findings outside the diff");
  });

  it("records the tier it reviewed at and hands it to the next run", async () => {
    const { calls, fetchImpl } = fakeGitHub();
    const r = report([finding(A, false)]);
    r.tier = "lite";
    await adapter(fetchImpl).publish(r);
    const body = postedSummary(calls);
    expect(readState(body)?.tier).toBe("lite");
    const next = await adapter(fakeGitHub([summaryComment(body)]).fetchImpl).getPriorReview();
    expect(next?.tier).toBe("lite");
  });
});
