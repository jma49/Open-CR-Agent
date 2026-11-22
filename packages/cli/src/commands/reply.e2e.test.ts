import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CompletionRequest, OcraPlugin } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { capture, deps } from "../run.fakes.js";
import { run } from "../run.js";
import { changeRequestFixture, fakeGitHub, removeFixtures } from "./review/change-request.fakes.js";

afterEach(removeFixtures);

const ANSWER = "It retries until `limit`; a negative limit never retries.";

function answering(seen: CompletionRequest[]): OcraPlugin {
  return {
    name: "runtime-opencode",
    configure(ctx) {
      ctx.registerRuntime("opencode", () => ({
        name: "fake",
        runTask: () => {
          throw new Error("reply runs no review task");
        },
        complete: async (request) => {
          seen.push(request);
          return {
            text: ANSWER,
            usage: {
              inputTokens: 9,
              outputTokens: 3,
              reasoningTokens: 0,
              cachedTokens: 0,
              costUsd: 0.02,
            },
          };
        },
      }));
    },
  };
}

// Pull request 7 with one conversation comment, id 4.
function withComment(body: string) {
  const { clone, base, head } = changeRequestFixture();
  const comment = {
    id: 4,
    node_id: "IC_4",
    user: { login: "maintainer", type: "User" },
    body,
  };
  const github = fakeGitHub(base, head, [comment]);
  const fetchImpl = (async (url: string, init?: RequestInit) =>
    url.endsWith("/issues/comments/4") && (init?.method ?? "GET") === "GET"
      ? Response.json({ ...comment, issue_url: "https://api.github.com/repos/o/r/issues/7" })
      : github.fetchImpl(url, init)) as typeof fetch;
  return { clone, calls: github.calls, fetchImpl };
}

async function reply(cwd: string, args: string[], fetchImpl?: typeof fetch) {
  const seen: CompletionRequest[] = [];
  const out = capture();
  const err = capture();
  const code = await run(
    ["reply", ...args],
    out,
    err,
    deps(cwd, async function* () {}, {
      runtimes: { opencode: async () => answering(seen) },
      env: { GITHUB_TOKEN: "t" },
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    }),
  );
  return { code, seen, out: out.text(), err: err.text() };
}

describe("ocra reply", () => {
  it("answers a maintainer's mention in its thread, from the change", async () => {
    const { clone, calls, fetchImpl } = withComment("@ocra what happens when limit is negative?");
    const result = await reply(clone, ["--pr", "7", "--repo", "o/r", "--comment", "4"], fetchImpl);
    expect(result.code).toBe(0);
    expect(result.seen).toHaveLength(1);
    expect(result.seen[0]?.user).toContain("what happens when limit is negative?");
    expect(result.seen[0]?.user).toContain("export const retries = -1;");
    const posted = calls.filter((c) => c.method === "POST" && c.path === "/issues/7/comments");
    expect(posted).toHaveLength(1);
    const text = (posted[0]?.body as { body?: string } | undefined)?.body;
    expect(text).toContain("<!-- ocra:reply 4 -->");
    expect(text).toContain(ANSWER);
    expect(result.err).toContain("[ocra] Answered maintainer; $0.0200");
  });

  it("calls no model for a comment that asks ocra nothing, and says why", async () => {
    const { clone, calls, fetchImpl } = withComment("Looks good to me.");
    const result = await reply(clone, ["--pr", "7", "--repo", "o/r", "--comment", "4"], fetchImpl);
    expect(result.code).toBe(0);
    expect(result.seen).toHaveLength(0);
    expect(result.err).toContain("[ocra] Not answering:");
    expect(calls.filter((c) => c.method === "POST" && !c.path.endsWith("/graphql"))).toEqual([]);
  });

  it("takes ocra's account from --config, as a review does", async () => {
    const { clone, fetchImpl } = withComment("@ocra what happens when limit is negative?");
    const config = join(clone, "..", `reply-config-${Date.now()}.json`);
    writeFileSync(config, JSON.stringify({ github: { botLogin: "maintainer" } }));
    const args = ["--pr", "7", "--repo", "o/r", "--comment", "4", "--config", config];
    const result = await reply(clone, args, fetchImpl);
    expect(result.code).toBe(0);
    expect(result.seen).toHaveLength(0);
    expect(result.err).toContain("[ocra] Not answering:");
  });

  it("refuses a call without a change request or a comment", async () => {
    const { clone } = changeRequestFixture();
    expect((await reply(clone, ["--comment", "4"])).err).toContain("needs --pr or --mr");
    const noComment = await reply(clone, ["--pr", "7"]);
    expect(noComment.code).toBe(2);
    expect(noComment.err).toContain("needs --comment");
    expect(noComment.err).toContain("Usage: ocra reply");
    expect((await reply(clone, ["--mr", "7", "--comment", "4", "--inline"])).err).toContain(
      "--inline goes with --pr",
    );
  });
});
