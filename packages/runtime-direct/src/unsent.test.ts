import type { AgentEvent, CustomProvider } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { DirectRuntime } from "./runtime.js";

// A company endpoint behind a certificate authority Node does not trust.
const untrusted = Object.assign(new Error("unable to verify the first certificate"), {
  code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
});
const WHY =
  "fetch failed: unable to verify the first certificate (trust the server's certificate authority with NODE_EXTRA_CA_CERTS)";

async function failure(provider: Pick<CustomProvider, "api" | "baseUrl">): Promise<string> {
  const runtime = new DirectRuntime({
    models: { standard: ["corp/m1"] },
    tools: [],
    env: {},
    providers: { corp: { ...provider, models: { m1: { input: 0, output: 0 } } } },
    fetch: async () => {
      throw new TypeError("fetch failed", { cause: untrusted });
    },
  });
  const events: AgentEvent[] = [];
  const task = {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard" as const,
    systemPrompt: "system",
    userPrompt: "user",
    context: {
      readFile: async () => undefined,
      readDiff: () => undefined,
      searchCode: async () => [],
    },
    timeoutMs: 10_000,
  };
  for await (const event of runtime.runTask(task, new AbortController().signal)) events.push(event);
  return JSON.stringify(events);
}

describe("a request the direct runtime could not send", () => {
  it("names its cause on a chat completions endpoint", async () => {
    expect(await failure({ baseUrl: "https://llm.corp.test/v1" })).toContain(WHY);
  });

  it("names its cause on a Messages endpoint", async () => {
    expect(await failure({ api: "anthropic", baseUrl: "https://llm.corp.test" })).toContain(WHY);
  });
});
