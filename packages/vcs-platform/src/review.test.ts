import { describe, expect, it } from "vitest";
import {
  AUTHOR,
  BASE,
  conformance,
  HEAD,
  MAINTAINER,
  OCRA,
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
    resolveThread: async () => {},
  };
  return {
    review: new PlatformReview({ name: "memory", platform, code }),
    inline: () => inline,
    summary: () => summary,
  };
}

conformance("in memory", { conversation: inMemory });

describe("declinesFinding", () => {
  it("takes a clear decline or the dismiss command, not a question or other words", () => {
    expect(declinesFinding("Won't fix: the caller validates it.")).toBe(true);
    expect(declinesFinding("/ocra dismiss")).toBe(true);
    expect(declinesFinding("By design?")).toBe(false);
    expect(declinesFinding("I agree this is not intended.")).toBe(false);
  });
});
