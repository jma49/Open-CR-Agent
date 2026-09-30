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
import type { ReviewPlatform } from "./platform.js";
import { declinesFinding, PlatformReview } from "./review.js";

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
  let summary = "";
  const platform: ReviewPlatform = {
    text: { changeRequest: "change request", authority: "write access" },
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
    writeSummary: async (_, body) => {
      summary = body;
    },
    resolveThread: async (id) => {
      resolved.push(id);
    },
  };
  return {
    review: new PlatformReview({ name: "memory", platform, code }),
    inline: () => inline,
    summary: () => summary,
    resolved: () => resolved,
  };
}

conformance("in memory", { conversation: inMemory });

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

describe("declinesFinding", () => {
  it("takes a clear decline or the dismiss command, not a question or other words", () => {
    expect(declinesFinding("Won't fix: the caller validates it.")).toBe(true);
    expect(declinesFinding("/ocra dismiss")).toBe(true);
    expect(declinesFinding("By design?")).toBe(false);
    expect(declinesFinding("I agree this is not intended.")).toBe(false);
  });
});
