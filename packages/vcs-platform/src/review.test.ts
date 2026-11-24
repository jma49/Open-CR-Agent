import type { ChangeCommit } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import {
  AUTHOR,
  BASE,
  conformance,
  HEAD,
  MAINTAINER,
  OCRA,
  report,
  type Scenario,
} from "./conformance.fakes.js";
import { declinesFinding } from "./declined.js";
import type { ReviewPlatform } from "./platform.js";
import { PlatformReview } from "./review.js";
import { SUMMARY_MARKER } from "./state.js";
import { githubSuggestion } from "./suggestion.js";

const BOT = "ocra-bot";
const code = {
  getDiff: async () => [],
  readFile: async () => undefined,
  searchCode: async () => [],
};

// The protocol on its own: a platform that holds the scenario in memory.
function inMemory(scenario: Scenario) {
  const spell = (login: string) => (login === OCRA ? BOT : login);
  const comments = (scenario.comments ?? []).map((c, i) => ({
    id: String(i),
    author: spell(c.author),
    body: c.body,
    ...(c.editedBy ? { editedBy: spell(c.editedBy) } : {}),
  }));
  const inline: string[] = [];
  const resolved: string[] = [];
  const replies: string[] = [];
  const written: string[] = [];
  const commits: ChangeCommit[] = [];
  let summary = "";
  const platform: ReviewPlatform = {
    text: { changeRequest: "change request", authority: "write access" },
    suggestionFence: githubSuggestion,
    bot: async () => ({ login: BOT, is: (login) => login === BOT }),
    changeRequest: async () => ({
      id: "7",
      title: "t",
      description: "",
      baseSha: BASE,
      headSha: HEAD,
      author: AUTHOR,
    }),
    comments: async () => comments.map(({ id, author, body }) => ({ id, author, body })),
    editor: async (comment) => comments.find((c) => c.id === comment.id)?.editedBy,
    canWrite: async (login) => login === AUTHOR || login === MAINTAINER,
    linkedTasks: async () => [],
    threads: async () =>
      (scenario.threads ?? []).map((t, i) => ({
        id: `T${i}`,
        resolved: t.resolvedBy !== undefined,
        ...(t.resolvedBy ? { resolvedBy: t.resolvedBy } : {}),
        comments: t.comments.map((c) => ({
          author: spell(c.author),
          body: c.body,
          ...(c.editedBy ? { editor: spell(c.editedBy) } : {}),
        })),
      })),
    publishFindings: async (_, fresh) => {
      inline.push(...fresh.map((f) => f.body));
      return { posted: fresh.map((f) => f.finding.fingerprint), warnings: [] };
    },
    writeSummary: async (existing, body) => {
      if (!existing) written.push(body);
      summary = body;
    },
    resolveThread: async (id) => {
      resolved.push(id);
    },
    discussion: async ({ id }) => {
      const at = comments.findIndex((c) => c.id === id);
      const comment = comments[at];
      if (!comment) return undefined;
      const said = ({ author, body }: (typeof comments)[number]) => ({ author, body });
      return {
        comment: {
          id,
          author: comment.author,
          body: comment.body,
          ...(comment.editedBy ? { editor: comment.editedBy } : {}),
        },
        earlier: comments.slice(0, at).map(said),
        later: comments.slice(at + 1).map(said),
      };
    },
    reply: async (_, body) => {
      replies.push(body);
    },
    commit: async (commit) => {
      commits.push(commit);
      return { committed: true, sha: "c".repeat(40) };
    },
    checks: async () => [],
    failingOnBase: async () => [],
  };
  return {
    review: new PlatformReview({ name: "memory", platform, code }),
    commits: () => commits,
    inline: () => inline,
    summary: () => summary,
    replies: () => replies,
    resolved: () => resolved,
    written: () => written,
  };
}

conformance("in memory", { conversation: inMemory, commentId: String });

describe("resolving the threads of fixed findings", () => {
  it("resolves only ocra's threads whose marker nobody else edited", async () => {
    const fixed = "b".repeat(16);
    const marker = `<!-- ocra:finding ${fixed} -->\nA finding`;
    const conversation = inMemory({
      threads: [
        { comments: [{ author: OCRA, body: marker }] },
        { comments: [{ author: OCRA, body: marker, editedBy: AUTHOR }] },
        { comments: [{ author: MAINTAINER, body: marker }] },
      ],
    });
    await conversation.review.publish({
      ...report([]),
      rereview: {
        fixed: [
          {
            fingerprint: fixed,
            title: "t",
            file: "src/a.ts",
            severity: "warning",
            commented: true,
          },
        ],
        notReproduced: [],
        notRechecked: [],
        unchanged: [],
        dismissed: [],
      },
    });
    expect(conversation.resolved()).toEqual(["T0"]);
  });
});

describe("a round's note", () => {
  it("is a comment of its own, never the summary rewritten", async () => {
    const conversation = inMemory({
      comments: [{ author: OCRA, body: `${SUMMARY_MARKER}\nthe review's summary` }],
    });
    await conversation.review.note({
      commitSha: "c".repeat(40),
      fixed: [{ title: "Loop reads past the end", file: "src/total.ts" }],
      left: [],
    });
    expect(conversation.written()).toHaveLength(1);
    expect(conversation.written()[0]).toContain("ocra committed `cccccccccccc` with 1 fix");
    expect(conversation.written()[0]).not.toContain(SUMMARY_MARKER);
  });
});

describe("committing to the change request", () => {
  const file = { path: "src/a.test.ts", content: "x\n", created: true, executable: false };

  it("hands the platform a commit made from the head ocra read", async () => {
    const conversation = inMemory({});
    const commit = { parent: HEAD, message: "test: add tests", files: [file] };
    expect(await conversation.review.commit(commit)).toEqual({
      committed: true,
      sha: "c".repeat(40),
    });
    expect(conversation.commits()).toEqual([commit]);
  });

  it("writes nothing for edits made from another head", async () => {
    const conversation = inMemory({});
    const result = await conversation.review.commit({ parent: BASE, message: "m", files: [file] });
    expect(result).toMatchObject({ committed: false, outcome: "head_moved" });
    expect(conversation.commits()).toEqual([]);
  });

  it.each([
    "../outside.ts",
    "/etc/passwd",
    "src/../../x.ts",
    ".git/hooks/pre-commit",
    "src/.GIT/config",
    "src//a.ts",
    "./a.ts",
    "src\\a.ts",
    "a\nb.ts",
  ])("refuses to commit to %j", async (path) => {
    const conversation = inMemory({});
    await expect(
      conversation.review.commit({ parent: HEAD, message: "m", files: [{ ...file, path }] }),
    ).rejects.toThrow("ocra does not commit to");
    expect(conversation.commits()).toEqual([]);
  });

  it("refuses one path named twice, in any case", async () => {
    const conversation = inMemory({});
    const files = [file, { ...file, path: "SRC/a.test.ts" }];
    await expect(conversation.review.commit({ parent: HEAD, message: "m", files })).rejects.toThrow(
      "ocra does not commit to",
    );
  });
});

describe("declinesFinding", () => {
  it("takes a clear decline or the dismiss command, not a question or other words", () => {
    expect(declinesFinding("Won't fix: the caller validates it.")).toBe(true);
    expect(declinesFinding("/ocra dismiss")).toBe(true);
    expect(declinesFinding("By design?")).toBe(false);
    expect(declinesFinding("I agree this is not intended.")).toBe(false);
  });
});
