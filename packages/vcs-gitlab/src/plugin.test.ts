import type { ConfigureContext, VcsFactory } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { gitlabPlugin } from "./plugin.js";

function factory(): VcsFactory {
  let made: VcsFactory | undefined;
  gitlabPlugin.configure?.({
    registerVcs: (_name: string, f: VcsFactory) => {
      made = f;
    },
  } as unknown as ConfigureContext);
  if (!made) throw new Error("no VCS registered");
  return made;
}

describe("gitlabPlugin", () => {
  it("stops waiting out a rate limit once the run is interrupted", async () => {
    const controller = new AbortController();
    const limited = (async () =>
      new Response("", { status: 429, headers: { "retry-after": "60" } })) as typeof fetch;
    const adapter = factory()({
      project: 42,
      iid: 7,
      token: "t",
      apiUrl: "https://gitlab.example.com/api/v4",
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
