import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTaskSpec, CompletionRequest, Effort } from "@open-cr-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collect, fakeContext } from "../../core/src/runtime/conformance.fakes.js";
import { type FakeMessages, type MessagesReply, messagesEndpoint } from "./anthropic.fakes.js";
import { RECORD_DIR_ENV } from "./record.js";
import { DirectRuntime } from "./runtime.js";

const KEY = "sk-ant-direct-secret";
const endpoints: FakeMessages[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});

async function endpoint(script: readonly MessagesReply[]) {
  const server = await messagesEndpoint(script);
  endpoints.push(server);
  return server;
}

function runtime(
  url: string,
  options: { chain?: string[]; keyless?: boolean; sampling?: boolean; recordDir?: string } = {},
) {
  const chain = options.chain ?? ["claude/m1"];
  return new DirectRuntime({
    models: { standard: chain, light: chain, top: chain },
    tools: [],
    env: { CLAUDE_KEY: KEY, ...(options.recordDir ? { [RECORD_DIR_ENV]: options.recordDir } : {}) },
    ...(options.sampling ? { sampling: { temperature: 0, seed: 7 } } : {}),
    providers: {
      claude: {
        api: "anthropic",
        baseUrl: url,
        ...(options.keyless ? {} : { apiKeyEnv: "CLAUDE_KEY" }),
        models: { m1: { input: 3, output: 15, cachedInput: 0.3 }, m2: { input: 1, output: 2 } },
      },
    },
  });
}

function task(effort?: Effort): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "security",
    modelTier: "standard",
    ...(effort ? { effort } : {}),
    systemPrompt: "system",
    userPrompt: "user",
    context: fakeContext(),
    timeoutMs: 10_000,
  };
}

function call(effort?: Effort): CompletionRequest {
  return {
    tier: "top",
    agent: "judge",
    ...(effort ? { effort } : {}),
    system: "s",
    user: "u",
    timeoutMs: 10_000,
  };
}

const FINDING = {
  file: "src/a.ts",
  existingCode: "const a = 1;",
  severity: "warning",
  title: "t",
  body: "b",
};
const signal = () => new AbortController().signal;

describe("DirectRuntime on a Messages endpoint", () => {
  it("runs the tool loop in Anthropic's protocol and reports what the model found", async () => {
    const server = await endpoint([
      { toolCalls: [{ name: "read_file", input: { path: "src/a.ts" } }] },
      { toolCalls: [{ name: "report_finding", input: FINDING }] },
      { text: "Reviewed.", toolCalls: [{ name: "task_done", input: {} }] },
    ]);
    const events = await collect(runtime(server.url).runTask(task(), signal()));

    expect(events.find((e) => e.type === "finding")).toMatchObject({
      finding: FINDING,
      model: "claude/m1",
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
    const [first, second] = server.seen;
    expect(first).toMatchObject({ apiKey: undefined, authorization: `Bearer ${KEY}` });
    expect(first?.body).toMatchObject({
      model: "m1",
      stream: true,
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "user", cache_control: { type: "ephemeral" } }],
        },
      ],
    });
    expect(first?.body.tools?.map((t) => t.name)).toContain("report_finding");
    expect(first?.body.tools?.[0]?.input_schema).toMatchObject({ type: "object" });
    // The call goes back as the model made it, with the tool's output; only
    // the newest block carries the cache mark.
    expect(second?.body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "user" }] },
      {
        role: "assistant",
        content: [expect.objectContaining({ type: "tool_use", name: "read_file" })],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1_0",
            content: expect.stringContaining("const a = 1;"),
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  it("marks the starts a task shares with the run's others, in blocks that read as the prompt", async () => {
    const server = await endpoint([
      { text: "Reviewed.", toolCalls: [{ name: "task_done", input: {} }] },
    ]);
    const spec = {
      ...task(),
      userPrompt: "change guidelines files",
      sharedPrefixes: [0, 6, 17, 23],
    };
    await collect(runtime(server.url).runTask(spec, signal()));

    const mark = { cache_control: { type: "ephemeral" } };
    expect(server.seen[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "change", ...mark },
          { type: "text", text: " guidelines", ...mark },
          { type: "text", text: " files", ...mark },
        ],
      },
    ]);
  });

  it("only ends a block at a start past the two a task can mark", async () => {
    const server = await endpoint([
      { text: "Reviewed.", toolCalls: [{ name: "task_done", input: {} }] },
    ]);
    const spec = {
      ...task(),
      userPrompt: "change guidelines files plan",
      sharedPrefixes: [6, 17, 23],
    };
    await collect(runtime(server.url).runTask(spec, signal()));

    const mark = { cache_control: { type: "ephemeral" } };
    expect(server.seen[0]?.body.messages[0]?.content).toEqual([
      { type: "text", text: "change", ...mark },
      { type: "text", text: " guidelines", ...mark },
      { type: "text", text: " files" },
      { type: "text", text: " plan", ...mark },
    ]);
  });

  it("sends a completion a task follows as that task opens, and stores its starts", async () => {
    const server = await endpoint([
      { text: "- check it", toolCalls: [{ name: "read_file", input: { path: "src/a.ts" } }] },
    ]);
    const request = {
      ...call(),
      user: "change guidelines files list",
      sharedPrefixes: [6, 17, 23],
    };
    const result = await runtime(server.url).complete(request, signal());

    const mark = { cache_control: { type: "ephemeral" } };
    expect(server.seen).toHaveLength(1);
    expect(server.seen[0]?.body.tools?.map((t) => t.name)).toContain("report_finding");
    expect(server.seen[0]?.body.messages[0]?.content).toEqual([
      { type: "text", text: "change", ...mark },
      { type: "text", text: " guidelines", ...mark },
      { type: "text", text: " files", ...mark },
      { type: "text", text: " list" },
    ]);
    expect(result.text).toBe("- check it");
  });

  it("stores no conversation a completion would never read again", async () => {
    const server = await endpoint([{ text: "ok" }]);
    await runtime(server.url).complete(call(), signal());

    expect(server.seen[0]?.body).toMatchObject({
      system: [{ type: "text", text: "s", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "u" }] }],
    });
    expect(JSON.stringify(server.seen[0]?.body.messages)).not.toContain("cache_control");
  });

  it("prices fresh, stored and cached input apart", async () => {
    const server = await endpoint([
      { text: "ok", usage: { input: 10, cacheRead: 1000, cacheWrite: 200, output: 5 } },
    ]);
    const result = await runtime(server.url).complete(call(), signal());

    expect(result.usage).toMatchObject({ inputTokens: 210, cachedTokens: 1000, outputTokens: 5 });
    expect(result.usage.costUsd).toBeCloseTo(
      10 * 3e-6 + 200 * 3e-6 * 1.25 + 1000 * 0.3e-6 + 5 * 15e-6,
      12,
    );
  });

  it.each([
    ["high", { output_config: { effort: "high" }, thinking: { type: "adaptive" } }],
    ["minimal", { output_config: { effort: "low" }, thinking: { type: "adaptive" } }],
    ["none", { output_config: { effort: "low" }, thinking: undefined }],
  ] as const)("sends the effort %s as the API takes it", async (effort, sent) => {
    const server = await endpoint([{ text: "ok" }]);
    await runtime(server.url).complete(call(effort), signal());

    expect(server.seen[0]?.body.output_config).toEqual(sent.output_config);
    expect(server.seen[0]?.body.thinking).toEqual(sent.thinking);
  });

  it("sends no sampling settings, and says so", async () => {
    const server = await endpoint([{ text: "ok" }, { text: "ok" }]);
    const direct = runtime(server.url, { sampling: true });
    await direct.complete(call(), signal());
    await direct.complete(call("none"), signal());

    for (const { body } of server.seen) {
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("seed");
    }
    expect(direct.appliedTo("judge")).toEqual({
      effort: true,
      notApplied: ["temperature", "seed"],
    });
  });

  it("goes on without an effort the model refuses", async () => {
    const refusal = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "thinking.type: adaptive is not supported" },
    });
    const server = await endpoint([{ status: 400, body: refusal }, { text: "ok" }, { text: "ok" }]);
    const direct = runtime(server.url);
    const first = await direct.complete(call("high"), signal());
    await direct.complete(call("high"), signal());

    expect(first.text).toBe("ok");
    expect(server.seen.map((s) => s.body.output_config)).toEqual([
      { effort: "high" },
      undefined,
      undefined,
    ]);
    expect(direct.appliedTo("judge")).toEqual({ effort: false });
  });

  it.each([
    ["refusal", "declined"],
    ["max_tokens", "cut off"],
  ])("fails over when an answer stops with %s", async (stopReason, why) => {
    const server = await endpoint([
      { text: "partial", stopReason },
      { text: "from m2" },
      { text: "partial", stopReason },
    ]);
    const result = await runtime(server.url, { chain: ["claude/m1", "claude/m2"] }).complete(
      call(),
      signal(),
    );
    const alone = await runtime(server.url)
      .complete(call(), signal())
      .catch((error: unknown) => String(error));

    expect(result.text).toBe("from m2");
    expect(server.seen.map((s) => s.body.model)).toEqual(["m1", "m2", "m1"]);
    expect(JSON.stringify(alone)).toContain(why);
  });

  it("sends a request again once after a failure a moment may cure", async () => {
    const server = await endpoint([{ status: 529 }, { text: "ok" }]);
    const result = await runtime(server.url).complete(call(), signal());

    expect(result.text).toBe("ok");
    expect(server.seen).toHaveLength(2);
  });

  it("keeps the key out of an error the endpoint echoes it in", async () => {
    const server = await endpoint([
      { status: 401, body: JSON.stringify({ error: { message: `bad key ${KEY}` } }) },
    ]);
    const outcome = await runtime(server.url)
      .complete(call(), signal())
      .catch((error: unknown) => String(error));

    expect(JSON.stringify(outcome)).toContain("bad key");
    expect(JSON.stringify(outcome)).not.toContain(KEY);
  });

  it("records each exchange without its key, the system prompt telling two apart", async () => {
    const recordDir = mkdtempSync(join(tmpdir(), "ocra-messages-"));
    try {
      const server = await endpoint([{ text: "one" }, { text: "two" }]);
      const direct = runtime(server.url, { recordDir });
      await direct.complete(call(), signal());
      const second = await direct.complete({ ...call(), system: "another" }, signal());

      expect(second.text).toBe("two");
      const files = readdirSync(recordDir);
      expect(files).toHaveLength(2);
      const written = files.map((file) => readFileSync(join(recordDir, file), "utf8")).join("");
      expect(written).toContain("message_stop");
      expect(written).not.toContain(KEY);
    } finally {
      rmSync(recordDir, { recursive: true, force: true });
    }
  });

  it("sends no credential of the machine's own to an endpoint declared without a key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-ambient");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "ambient-token");
    const server = await endpoint([{ text: "ok" }]);
    await runtime(server.url, { keyless: true }).complete(call(), signal());

    expect(server.seen[0]).toMatchObject({ apiKey: undefined, authorization: undefined });
  });
});
