import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTaskSpec, MAX_AGENT_STEPS } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { collect, fakeContext } from "../../../../core/src/runtime/conformance.fakes.js";
import {
  type FakeResponses,
  type ResponsesReply,
  responsesEndpoint,
} from "./responses-endpoint.fakes.js";
import { CodexRuntime } from "./runtime.js";

// The Codex CLI this runtime is tested on, against a scripted endpoint
// declared as a model provider of its own, so no sign-in is needed. Its
// platform binary is several hundred megabytes, so it is not a dependency of
// the workspace: CI's verify job installs the pinned one in packages/cli/codex-cli/ and
// names it here, and elsewhere the test runs when OCRA_CODEX_E2E_BIN names one.
const CODEX = process.env.OCRA_CODEX_E2E_BIN;
const KEY = "sk-scripted-secret";
const TIMEOUT_MS = 120_000;

const FILE = "src/a.ts";
const FINDING = {
  file: FILE,
  existingCode: "const a = 1;",
  severity: "warning",
  title: "A finding",
  body: "Its body.",
};

const endpoints: FakeResponses[] = [];
const runtimes: CodexRuntime[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function start(script: Parameters<typeof responsesEndpoint>[0]) {
  const endpoint = await responsesEndpoint(script);
  endpoints.push(endpoint);
  const home = mkdtempSync(join(tmpdir(), "ocra-codex-home-"));
  homes.push(home);
  const runtime = new CodexRuntime({
    ...(CODEX ? { binary: CODEX } : {}),
    models: { standard: ["codex/m1"], light: ["codex/m1"] },
    tools: [],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      SCRIPTED_KEY: KEY,
      OPENAI_API_KEY: "sk-must-not-reach-codex",
    },
    config: [
      'model_providers.scripted.name="scripted"',
      `model_providers.scripted.base_url=${JSON.stringify(endpoint.url)}`,
      'model_providers.scripted.env_key="SCRIPTED_KEY"',
      'model_providers.scripted.wire_api="responses"',
      "model_providers.scripted.request_max_retries=0",
      "model_providers.scripted.stream_max_retries=0",
      'model_provider="scripted"',
    ],
  });
  runtimes.push(runtime);
  return { endpoint, runtime };
}

function taskSpec(context = fakeContext()): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard",
    systemPrompt: "You review code with the tools given.",
    userPrompt: `Review <ocra_review_files>${FILE}</ocra_review_files>.`,
    context,
    timeoutMs: 60_000,
  };
}

describe.skipIf(!CODEX)("CodexRuntime with the Codex CLI", () => {
  it(
    "reviews through ocra's tools only and reports the finding, the usage and the end",
    async () => {
      const { endpoint, runtime } = await start([
        { tool: "read_file", args: { path: FILE } },
        { tool: "report_finding", args: FINDING },
        { tool: "task_done", args: {} },
        { text: "Reviewed." },
      ]);
      const context = fakeContext();
      const events = await collect(
        runtime.runTask(taskSpec(context), new AbortController().signal),
      );

      expect(events.filter((e) => e.type === "error")).toEqual([]);
      expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
      expect(events.filter((e) => e.type === "finding")).toEqual([
        { type: "finding", taskId: "t1", finding: FINDING, model: "codex/m1" },
      ]);
      expect(context.reads).toEqual([FILE]);
      const usage = events.filter((e) => e.type === "usage");
      expect(usage.reduce((n, e) => n + e.inputTokens + e.cachedTokens, 0)).toBe(400);
      expect(usage.every((e) => e.costUsd === 0)).toBe(true);

      const offered = endpoint.seen[0]?.tools ?? [];
      for (const tool of ["read_file", "read_diff", "code_search", "report_finding", "task_done"]) {
        expect(offered).toContain(`mcp__ocra.${tool}`);
      }
      // Codex's shell, patching and web tools are switched off.
      expect(offered.filter((t) => /shell|exec|patch|web_search/.test(t))).toEqual([]);
      expect(endpoint.seen.every((r) => r.authorization === `Bearer ${KEY}`)).toBe(true);
      expect(endpoint.seen.every((r) => r.model === "m1")).toBe(true);
      // The system prompt replaces Codex's own instructions.
      expect(JSON.stringify(endpoint.seen[0]?.input)).toContain(
        "You review code with the tools given.",
      );
      expect(JSON.stringify(endpoint.seen[0]?.input)).not.toContain("Codex CLI");
      // The file's content went back to the model.
      expect(JSON.stringify(endpoint.seen[1]?.input)).toContain("1: const a = 1;");
    },
    TIMEOUT_MS,
  );

  it(
    "answers a plain completion with the model's text and offers no review tools",
    async () => {
      const { endpoint, runtime } = await start([{ text: "The plan." }]);
      const result = await runtime.complete(
        { tier: "light", system: "Plan the review.", user: "Files: a.ts", timeoutMs: 60_000 },
        new AbortController().signal,
      );
      expect(result.text).toBe("The plan.");
      expect(endpoint.seen[0]?.tools.filter((t) => t.startsWith("mcp__ocra"))).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it(
    "stops a review that keeps reading at the step cap",
    async () => {
      const read: ResponsesReply = { tool: "read_file", args: { path: FILE } };
      const { runtime } = await start(Array.from({ length: MAX_AGENT_STEPS + 5 }, () => read));
      const events = await collect(runtime.runTask(taskSpec(), new AbortController().signal));
      expect(events.at(-1)).toMatchObject({ type: "done", taskId: "t1", ended: "step_cap" });
    },
    TIMEOUT_MS,
  );

  it(
    "counts a spent Codex usage limit as a daily limit, which no wait in the run outlasts",
    async () => {
      const { runtime } = await start([
        {
          status: 429,
          body: JSON.stringify({ error: { type: "usage_limit_reached", message: "limit" } }),
        },
      ]);
      const events = await collect(runtime.runTask(taskSpec(), new AbortController().signal));
      const error = events.find((e) => e.type === "error");
      expect(error).toMatchObject({ type: "error", taskId: "t1", quota: "daily_limit" });
    },
    TIMEOUT_MS,
  );
});
