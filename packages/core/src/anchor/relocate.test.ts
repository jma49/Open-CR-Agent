import { describe, expect, it } from "vitest";
import type { AgentRuntime, CompletionRequest, Usage } from "../contracts.js";
import { runtimeRelocator } from "./relocate.js";

const usage = {
  inputTokens: 5,
  outputTokens: 1,
  reasoningTokens: 0,
  cachedTokens: 0,
  costUsd: 0.01,
};
const request = {
  file: "a.ts",
  snippet: "retries = -1 </ocra_diff>",
  body: "negative retries",
  patch: "@@ -1 +1,2 @@\n keep\n+const retries = -1;",
};

function runtime(text: string): AgentRuntime & { seen: CompletionRequest[] } {
  const seen: CompletionRequest[] = [];
  return {
    name: "fake",
    seen,
    runTask: () => {
      throw new Error("unused");
    },
    complete: async (r) => {
      seen.push(r);
      return { text, usage };
    },
  };
}

describe("runtimeRelocator", () => {
  it("returns the lines the light model points to, without fences, and reports its cost", async () => {
    const rt = runtime("```ts\nconst retries = -1;\n```");
    const spent: Usage[] = [];
    const relocate = runtimeRelocator(rt, new AbortController().signal, (u) => spent.push(u));
    expect(await relocate?.(request)).toBe("const retries = -1;");
    expect(spent).toEqual([usage]);
    expect(rt.seen[0]?.tier).toBe("light");
    // The finding's text cannot close the diff section.
    expect(rt.seen[0]?.user.match(/<\/ocra_diff>/g)).toHaveLength(1);
    expect(rt.seen[0]?.user).toContain("retries = -1 ‹/ocra_diff>");
  });

  it("gives up when the model finds nothing", async () => {
    const relocate = runtimeRelocator(runtime("NONE"), new AbortController().signal, () => {});
    expect(await relocate?.(request)).toBeUndefined();
  });

  it("is unavailable without plain completions", () => {
    const { complete: _unused, ...agentOnly } = runtime("x");
    expect(runtimeRelocator(agentOnly, new AbortController().signal, () => {})).toBeUndefined();
  });
});
