import { describe, expect, it } from "vitest";
import { adapter, type Call } from "./adapter.fakes.js";

const PULL = "https://api.github.com/repos/o/r/pulls/7";
const user = (login: string) => ({ login, type: "User" });

// A thread on src/retry.ts: its first comment by the author, then the
// maintainer's question, then a reply from another pull request's thread.
const lineComments = [
  {
    id: 10,
    node_id: "C10",
    body: "Retries twice.",
    user: user("author"),
    path: "src/retry.ts",
    line: 4,
  },
  {
    id: 11,
    node_id: "C11",
    body: "@ocra is twice enough?",
    user: user("maintainer"),
    path: "src/retry.ts",
    line: 4,
    in_reply_to_id: 10,
  },
  { id: 12, node_id: "C12", body: "Unrelated.", user: user("author"), path: "src/a.ts", line: 1 },
].map((c) => ({ ...c, pull_request_url: PULL }));

function github(issueUrl = "https://api.github.com/repos/o/r/issues/7") {
  const calls: Call[] = [];
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = url.replace("https://api.github.com/repos/o/r", "");
    calls.push({ method, path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.endsWith("/graphql")) return json({ data: { node: { editor: null } } });
    const line = /^\/pulls\/comments\/(\d+)$/.exec(path);
    if (line) {
      const found = lineComments.find((c) => c.id === Number(line[1]));
      return found ? json(found) : json({ message: "Not Found" }, 404);
    }
    if (path.startsWith("/pulls/7/comments?")) return json(lineComments);
    if (path === "/issues/comments/20") {
      return json({
        id: 20,
        node_id: "I20",
        body: "@ocra why?",
        user: user("maintainer"),
        issue_url: issueUrl,
      });
    }
    if (path.startsWith("/issues/7/comments?")) return json([]);
    if (path.endsWith("/permission")) return json({ permission: "write" });
    return json({}, 201);
  }) as typeof fetch;
  return { calls, review: adapter(fetchImpl) };
}

describe("a mention on GitHub", () => {
  it("reads a comment on a line with its thread and replies in that thread", async () => {
    const { calls, review } = github();
    const mention = await review.mention({ id: "11", inline: true });
    if (!mention.asked) throw new Error(mention.reason);
    expect(mention).toMatchObject({
      question: "is twice enough?",
      thread: [{ author: "author", body: "Retries twice." }],
      on: { path: "src/retry.ts", line: 4 },
    });
    await mention.answer("Yes.");
    const reply = calls.find((c) => c.method === "POST" && !c.path.endsWith("/graphql"));
    expect(reply?.path).toBe("/pulls/7/comments/10/replies");
    expect(reply?.body).toEqual({ body: "<!-- ocra:reply 11 -->\nYes." });
  });

  it("answers a comment on the conversation after it, quoting the question", async () => {
    const { calls, review } = github();
    const mention = await review.mention({ id: "20" });
    if (!mention.asked) throw new Error(mention.reason);
    await mention.answer("Because.");
    const reply = calls.find((c) => c.method === "POST" && !c.path.endsWith("/graphql"));
    expect(reply?.path).toBe("/issues/7/comments");
    expect((reply?.body as { body?: string } | undefined)?.body).toBe(
      "<!-- ocra:reply 20 -->\n> @​maintainer: why?\n\nBecause.",
    );
  });

  it("does not answer a comment on another pull request", async () => {
    const { review } = github("https://api.github.com/repos/o/r/issues/8");
    expect(await review.mention({ id: "20" })).toEqual({
      asked: false,
      reason: "the comment is not on this change request",
    });
  });
});
