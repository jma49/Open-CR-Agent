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

describe("verdict override", () => {
  const head = "cccccccccccccccccccccccccccccccccccccccc";
  const comment = (login: string, body: string) => ({
    id: 1,
    node_id: "IC_1",
    user: { login, type: "User" },
    author_association: "MEMBER",
    body,
  });
  const override = async (
    comments: unknown[],
    editor: { login: string } | null = null,
    permissions?: Record<string, string>,
  ) => {
    const { fetchImpl } = fakeGitHub(comments, 200, [], false, editor, [], undefined, permissions);
    return (await adapter(fetchImpl).getChangeRequest()).override;
  };

  it("takes /ocra override for the full head commit from someone with write access", async () => {
    expect(
      await override([comment("maintainer", `/ocra override ${head} accepted risk, see #12`)]),
    ).toEqual({
      by: "maintainer",
      reason: "accepted risk, see #12",
    });
  });

  it("refuses the author, readers, bots, other commits, short prefixes and misplaced commands", async () => {
    for (const c of [
      comment("author", `/ocra override ${head} mine`),
      comment("member-without-access", `/ocra override ${head} lgtm`),
      comment("github-actions[bot]", `/ocra override ${head} bot`),
      comment("maintainer", `/ocra override ${"d".repeat(40)} older commit`),
      comment("maintainer", "/ocra override ccccccc prefix only"),
      comment("maintainer", `please /ocra override ${head} later`),
    ]) {
      expect(await override([c])).toBeUndefined();
    }
  });

  it("ignores a command someone else edited into another person's comment", async () => {
    const c = comment("maintainer", `/ocra override ${head} planted by the author`);
    expect(await override([c], { login: "author" })).toBeUndefined();
    expect(await override([c], { login: "maintainer" })).toBeDefined();
    expect(await override([{ ...c, node_id: undefined }])).toBeUndefined();
  });

  it("shows the override in the summary, or how to give one", () => {
    const blocking = report([finding(A, false, "critical")], "significant_concerns");
    const how = renderSummary({ report: blocking, commented: new Set(), state: { findings: [] } });
    expect(how).toContain(`\`/ocra override ${head} <reason>\``);
    blocking.changeRequest = {
      ...blocking.changeRequest,
      headSha: head,
      override: { by: "maintainer", reason: "risk accepted [x](https://evil.example)" },
    };
    const done = renderSummary({ report: blocking, commented: new Set(), state: { findings: [] } });
    expect(done).toContain("## ocra review · 🛑 Significant concerns · overridden");
    expect(done).toContain("**Overridden** by @\u200bmaintainer for `ccccccc`");
    expect(done).toContain("risk accepted [x]\\(https://evil.example)");
  });

  it("withdraws its request for changes when the commit is overridden", async () => {
    const bot = { login: "github-actions[bot]" };
    const { calls, fetchImpl } = fakeGitHub([], 200, [], false, null, [
      { id: 11, state: "CHANGES_REQUESTED", user: bot },
    ]);
    const blocking = report([finding(A, true, "critical")], "significant_concerns");
    blocking.changeRequest = {
      ...blocking.changeRequest,
      override: { by: "maintainer", reason: "ok" },
    };
    await adapter(fetchImpl, true).publish(blocking);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual([
      "/pulls/7/reviews/11/dismissals",
    ]);
  });
});

describe("dismissals from replies", () => {
  const summary = (fingerprint: string) => ({
    id: 99,
    node_id: "IC_99",
    user: { login: "github-actions[bot]", type: "Bot" },
    body: `${SUMMARY_MARKER}\n${writeState({ findings: [prior({ fingerprint })] })}`,
  });
  const thread = (fingerprint: string, reply: Record<string, unknown>) => ({
    id: `T-${fingerprint}`,
    isResolved: false,
    resolvedBy: null,
    comments: {
      nodes: [
        { body: `<!-- ocra:finding ${fingerprint} -->`, author: { login: "github-actions" } },
        { authorAssociation: "MEMBER", ...reply },
      ],
    },
  });
  const dismissed = async (reply: Record<string, unknown>) => {
    const { fetchImpl } = fakeGitHub([summaryComment(summary(A).body)], 200, [thread(A, reply)]);
    return (await adapter(fetchImpl).getPriorReview())?.findings[0]?.dismissed === true;
  };

  it("count only unedited replies from people with write access", async () => {
    expect(await dismissed({ body: "won't fix", author: { login: "maintainer" } })).toBe(true);
    expect(
      await dismissed({
        body: "won't fix",
        author: { login: "maintainer" },
        editor: { login: "author" },
      }),
    ).toBe(false);
    expect(await dismissed({ body: "won't fix", author: { login: "member-without-access" } })).toBe(
      false,
    );
  });
});
