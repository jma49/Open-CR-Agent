import { readState, SUMMARY_MARKER, writeState } from "@open-cr-agent/vcs-platform";
import { describe, expect, it } from "vitest";
import { adapter, code, fakeGitHub, postedSummary, report } from "./adapter.fakes.js";
import { GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";

describe("GitHubAdapter", () => {
  describe("what changed since the previous review", () => {
    const head = "cccccccccccccccccccccccccccccccccccccccc";
    const earlier = "dddddddddddddddddddddddddddddddddddddddd";
    const summary = (state: Parameters<typeof writeState>[0]) => ({
      id: 99,
      node_id: "IC_99",
      user: { login: "github-actions[bot]", type: "Bot" },
      body: `${SUMMARY_MARKER}\n${writeState(state)}`,
    });
    const history = (answer: { files: string[] } | { reason: string }) => {
      const calls: string[][] = [];
      return {
        calls,
        filesChangedSince: async (from: string, to: string) => {
          calls.push([from, to]);
          return answer;
        },
      };
    };
    const prior = async (
      state: Parameters<typeof writeState>[0],
      h?: ReturnType<typeof history>,
      editor: { login: string } | null = null,
      nodeId = true,
    ) => {
      const comment = summary(state);
      const { fetchImpl } = fakeGitHub(
        [nodeId ? comment : { ...comment, node_id: undefined }],
        200,
        [],
        false,
        editor,
      );
      return new GitHubAdapter({
        pullRequest: { owner: "o", repo: "r", number: 7 },
        api: new GitHubApi(
          { owner: "o", repo: "r" },
          { token: "t", fetch: fetchImpl, sleep: async () => {} },
        ),
        code,
        botLogin: "github-actions[bot]",
        ...(h ? { history: h } : {}),
      }).getPriorReview();
    };

    it("lists files changed since the recorded head plus the unfinished ones", async () => {
      const h = history({ files: ["b.ts"] });
      const review = await prior({ findings: [], head: earlier, pending: ["a.ts", "b.ts"] }, h);
      expect(h.calls).toEqual([[earlier, head]]);
      expect(review?.changedSince).toEqual({ head: earlier, files: ["b.ts", "a.ts"] });
      expect(review?.fullReviewReason).toBeUndefined();
    });

    it("reviews everything, with a reason, when it cannot trust or compute the change", async () => {
      expect((await prior({ findings: [] }, history({ files: [] })))?.fullReviewReason).toBe(
        "the previous review did not record its commit",
      );
      expect((await prior({ findings: [], head: earlier }))?.fullReviewReason).toBe(
        "no repository history to compare with",
      );
      const rewritten = history({ reason: "commit ddddddd is not an ancestor of the new head" });
      expect((await prior({ findings: [], head: earlier }, rewritten))?.fullReviewReason).toBe(
        "commit ddddddd is not an ancestor of the new head",
      );
      const edited = await prior({ findings: [], head: earlier }, history({ files: [] }), {
        login: "contributor",
      });
      expect(edited?.fullReviewReason).toBe(
        "the previous review's summary was edited by someone else",
      );
      expect(edited?.changedSince).toBeUndefined();
      const unknown = await prior(
        { findings: [], head: earlier },
        history({ files: [] }),
        null,
        false,
      );
      expect(unknown?.fullReviewReason).toBe(
        "could not check who last edited the previous review's summary",
      );
    });

    it("records the reviewed head and unfinished files in the state", async () => {
      const { calls, fetchImpl } = fakeGitHub();
      const published = await adapter(fetchImpl).publish({
        ...report([]),
        coverage: [
          { path: "src/login.ts", status: "failed" },
          { path: "src/ok.ts", status: "reviewed" },
          { path: "src/same.ts", status: "unchanged" },
          // A task the spend limit never started.
          { path: "src/later.ts", status: "unreviewed" },
        ],
        spendLimit: { usd: 2, reached: "review" },
      });
      const state = readState(postedSummary(calls));
      expect(state?.head).toBe(head);
      expect(state?.pending).toEqual(["src/login.ts", "src/later.ts"]);
      expect(published.warnings).toEqual([]);
    });

    it("warns when the unfinished files do not fit, since the next review starts over", async () => {
      const { calls, fetchImpl } = fakeGitHub();
      const published = await adapter(fetchImpl).publish({
        ...report([]),
        coverage: Array.from({ length: 1_001 }, (_, i) => ({
          path: `src/f${i}.ts`,
          status: "unreviewed" as const,
        })),
      });
      expect(readState(postedSummary(calls))?.head).toBeUndefined();
      expect(published.warnings).toEqual([
        "the review state did not fit in the summary comment with its 1001 unfinished file(s): the next review of this pull request reviews every file again",
      ]);
    });

    it("drops the head when the unfinished files do not fit, forcing a full review", () => {
      const pending = Array.from({ length: 1_001 }, (_, i) => `f${i}.ts`);
      const state = readState(writeState({ findings: [], head, pending }));
      expect(state).toEqual({ findings: [] });
    });
  });
});
