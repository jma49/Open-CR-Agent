import { SUMMARY_MARKER, writeState } from "@open-cr-agent/vcs-platform";
import { describe, expect, it } from "vitest";
import {
  AUTHOR,
  BASE,
  finding,
  HEAD,
  MAINTAINER,
  OCRA,
  OUTSIDER,
  report,
} from "../../vcs-platform/src/conformance.fakes.js";
import { positionOf } from "./adapter.js";
import { adapter, bodies, diff, fakeGitLab, START } from "./gitlab.fakes.js";

const refs = { base_sha: BASE, start_sha: START, head_sha: HEAD };
const A = "a".repeat(16);
const B = "b".repeat(16);

const summaryOf = (fingerprint: string) =>
  `${SUMMARY_MARKER}\n${writeState({
    findings: [
      { fingerprint, title: "t", file: "src/login.ts", severity: "warning", commented: true },
    ],
    head: HEAD,
  })}`;

describe("GitLabAdapter", () => {
  it("maps the merge request to a change request", async () => {
    const { fetchImpl } = fakeGitLab({});
    expect(await adapter(fetchImpl).getChangeRequest()).toEqual({
      id: "group/project!7",
      title: "Add login",
      description: "",
      baseSha: START,
      headSha: HEAD,
    });
  });

  it("refuses a merge request whose diff GitLab has not prepared yet", async () => {
    const { fetchImpl } = fakeGitLab({}, { diffRefs: null });
    await expect(adapter(fetchImpl).getChangeRequest()).rejects.toThrow("has no diff yet");
  });

  it("comments on added and unchanged lines where GitLab expects them", () => {
    expect(positionOf("src/login.ts", 2, [diff], refs)).toEqual({
      position_type: "text",
      base_sha: BASE,
      start_sha: START,
      head_sha: HEAD,
      old_path: "src/login.ts",
      new_path: "src/login.ts",
      new_line: 2,
    });
    expect(positionOf("src/login.ts", 3, [diff], refs)).toMatchObject({ new_line: 3, old_line: 2 });
    expect(positionOf("src/login.ts", 9, [diff], refs)).toBeUndefined();
    expect(positionOf("src/other.ts", 2, [diff], refs)).toBeUndefined();
  });

  it("posts one thread per finding and keeps the ones GitLab refuses in the summary", async () => {
    const { calls, fetchImpl } = fakeGitLab(
      {},
      {
        // GitLab rejects the position of the finding on line 3.
        discussionStatus: (call) =>
          (call.body as { position: { new_line: number } }).position.new_line === 3 ? 400 : 201,
      },
    );
    const published = await adapter(fetchImpl).publish(
      report([
        finding(A, { lineRange: { start: 2, end: 2 }, title: "Placed" }),
        finding(B, { lineRange: { start: 3, end: 3 }, title: "Refused" }),
      ]),
    );
    expect(published.warnings).toEqual([]);
    const threads = bodies(calls, "POST", "/discussions");
    expect(threads).toEqual([
      expect.stringContaining("Placed"),
      expect.stringContaining("Refused"),
    ]);
    const [summary] = bodies(calls, "POST", "/notes");
    expect(summary).toContain("### Findings outside the diff");
    expect(summary).toContain("**Refused**");
    expect(summary).not.toContain("**Placed**");
  });

  it("turns a failed thread into a warning and still writes the summary", async () => {
    const { calls, fetchImpl } = fakeGitLab({}, { discussionStatus: () => 500 });
    const published = await adapter(fetchImpl).publish(
      report([finding(A, { lineRange: { start: 2, end: 2 } })]),
    );
    expect(published.warnings).toEqual([
      expect.stringMatching(
        /^could not comment on src\/login\.ts:2: GitLab POST .* failed with 500/,
      ),
    ]);
    expect(bodies(calls, "POST", "/notes")).toHaveLength(1);
    // A POST GitLab may have acted on is never repeated.
    expect(
      calls.filter((c) => c.method === "POST" && c.path.endsWith("/discussions")),
    ).toHaveLength(1);
  });

  it("updates its own summary instead of posting another", async () => {
    const { fetchImpl: first, calls: firstCalls } = fakeGitLab({});
    await adapter(first).publish(report([]));
    const [summary = ""] = bodies(firstCalls, "POST", "/notes");
    const { calls, fetchImpl } = fakeGitLab({ comments: [{ author: OCRA, body: summary }] });
    await adapter(fetchImpl).publish(report([]));
    expect(calls.some((c) => c.method === "PUT" && c.path.endsWith("/notes/1"))).toBe(true);
    expect(bodies(calls, "POST", "/notes")).toEqual([]);
  });

  it("counts the Developer role and up as write access, not outsiders", async () => {
    const override = (author: string) => ({ author, body: `/ocra override ${HEAD} ok` });
    const by = async (author: string) => {
      const { fetchImpl } = fakeGitLab({ comments: [override(author)] });
      return (await adapter(fetchImpl).getChangeRequest()).override?.by;
    };
    expect(await by(MAINTAINER)).toBe(MAINTAINER);
    expect(await by(OUTSIDER)).toBeUndefined();
    expect(await by(AUTHOR)).toBeUndefined();
  });

  it("trusts no note GitLab would not say the editor of", async () => {
    const summary = `${SUMMARY_MARKER}\n${writeState({
      findings: [
        { fingerprint: A, title: "t", file: "src/login.ts", severity: "warning", commented: true },
      ],
      head: HEAD,
    })}`;
    const { fetchImpl } = fakeGitLab(
      {
        comments: [
          { author: OCRA, body: summary },
          { author: MAINTAINER, body: `/ocra override ${HEAD} ok` },
        ],
        threads: [
          {
            comments: [
              { author: OCRA, body: `<!-- ocra:finding ${A} -->` },
              { author: MAINTAINER, body: "The caller checks it." },
            ],
          },
        ],
      },
      // The override (note 2) and the reply (note 101).
      { unknownEditors: [2, 101] },
    );
    const review = adapter(fetchImpl);
    expect((await review.getChangeRequest()).override).toBeUndefined();
    const prior = await review.getPriorReview();
    expect(prior?.findings.map((f) => f.fingerprint)).toEqual([A]);
    expect(prior?.replies).toBeUndefined();
  });

  it("reads who edited a thread after reading the thread", async () => {
    // The author edits the maintainer's reply (note 101) right after ocra
    // checked who edited its summary: the reply must not count unedited.
    const { fetchImpl } = fakeGitLab(
      {
        comments: [{ author: OCRA, body: summaryOf(A) }],
        threads: [
          {
            comments: [
              { author: OCRA, body: `<!-- ocra:finding ${A} -->` },
              { author: MAINTAINER, body: "The caller checks it." },
            ],
          },
        ],
      },
      { editedAfterFirstRead: { 101: AUTHOR } },
    );
    const prior = await adapter(fetchImpl).getPriorReview();
    expect(prior?.findings.map((f) => f.fingerprint)).toEqual([A]);
    expect(prior?.replies).toBeUndefined();
  });

  it.each([
    [false, true],
    [true, false],
    // GitLab did not say: no resolution counts.
    [null, false],
  ])(
    "with resolving outdated threads on push set to %s, a resolution dismisses: %s",
    async (setting, dismissed) => {
      const scenario = {
        comments: [{ author: OCRA, body: summaryOf(A) }],
        threads: [
          {
            resolvedBy: MAINTAINER,
            comments: [{ author: OCRA, body: `<!-- ocra:finding ${A} -->` }],
          },
        ],
      };
      const { calls, fetchImpl } = fakeGitLab(scenario, { resolvesOutdatedOnPush: setting });
      const review = adapter(fetchImpl);
      const prior = await review.getPriorReview();
      expect(prior?.findings.find((f) => f.fingerprint === A)?.dismissed === true).toBe(dismissed);
      if (dismissed) return;
      // The finding comes back, and the summary says why resolving did nothing.
      await review.publish(report([finding(A, { lineRange: { start: 2, end: 2 } })]));
      expect(bodies(calls, "PUT", "/notes/1")[0]).toContain(
        "1 resolved thread(s) of ocra's did not dismiss their finding",
      );
    },
  );

  it("dismisses nothing when GitLab cannot say who edited what", async () => {
    const summary = await (async () => {
      const { fetchImpl, calls } = fakeGitLab({});
      await adapter(fetchImpl).publish(report([finding(A, { lineRange: { start: 2, end: 2 } })]));
      return bodies(calls, "POST", "/notes")[0] ?? "";
    })();
    const { fetchImpl } = fakeGitLab(
      {
        comments: [{ author: OCRA, body: summary }],
        threads: [
          {
            resolvedBy: MAINTAINER,
            comments: [{ author: OCRA, body: `<!-- ocra:finding ${A} -->` }],
          },
        ],
      },
      { graphqlFails: true },
    );
    // Without editors, the summary's state cannot be trusted either.
    expect(await adapter(fetchImpl).getPriorReview()).toEqual({
      findings: [],
      fullReviewReason: "could not check who last edited the previous review's summary",
    });
  });
});
