import type { ConfigureContext, VcsFactory } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { githubPlugin } from "./plugin.js";

function factory(): VcsFactory {
  let made: VcsFactory | undefined;
  githubPlugin.configure?.({
    registerVcs: (_name: string, f: VcsFactory) => {
      made = f;
    },
  } as unknown as ConfigureContext);
  if (!made) throw new Error("no VCS registered");
  return made;
}

describe("githubPlugin", () => {
  it("stops waiting out a rate limit once the run is interrupted", async () => {
    const controller = new AbortController();
    const limited = (async () =>
      new Response("", { status: 429, headers: { "retry-after": "60" } })) as typeof fetch;
    const adapter = factory()({
      owner: "o",
      repo: "r",
      number: 7,
      token: "t",
      code: {
        getDiff: async () => [],
        readFile: async () => undefined,
        searchCode: async () => [],
      },
      history: { filesChangedSince: async () => ({ files: [] }) },
      fetch: limited,
      signal: controller.signal,
    }) as unknown as { comments(): Promise<unknown> };
    const listed = adapter.comments().then(
      () => "answered",
      (error: unknown) => (error === controller.signal.reason ? "aborted" : error),
    );
    setTimeout(() => controller.abort(), 20);
    const outcome = await Promise.race([
      listed,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
    ]);
    expect(outcome).toBe("aborted");
  });
});
