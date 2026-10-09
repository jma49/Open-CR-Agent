import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTaskSpec, Env } from "@open-cr-agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collect,
  type FakeEndpoint,
  fakeContext,
  type Reply,
  scriptedEndpoint,
} from "../../core/src/runtime/conformance.fakes.js";
import { RECORD_DIR_ENV } from "./record.js";
import { type ReplayEndpoint, replayEndpoint } from "./replay.fakes.js";
import { DirectRuntime } from "./runtime.js";

const KEY = "sk-record-secret";
const FINDING = {
  file: "src/a.ts",
  existingCode: "const a = 1;",
  severity: "warning",
  title: "A finding",
  body: "Its body.",
};
// A task that ends in text, without task_done, steps to spare: the case a
// wrap-up turn is for. Re-record with OCRA_RERECORD=1 after a change to the
// review tools or this spec makes it "not replayable".
const STOPPED_EARLY = join(import.meta.dirname, "recordings", "stopped-early");

const servers: (FakeEndpoint | ReplayEndpoint)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-record-"));
  dirs.push(dir);
  return dir;
}

function runtime(url: string, env: Record<string, string> = {}) {
  return runtimeWith(url, { LOCAL_KEY: KEY, ...env });
}

function runtimeWith(url: string, env: Env) {
  return new DirectRuntime({
    models: { standard: ["local/m1"], light: ["local/m1"] },
    tools: [],
    env,
    providers: {
      local: { baseUrl: url, apiKeyEnv: "LOCAL_KEY", models: { m1: { input: 3, output: 15 } } },
    },
  });
}

function spec(
  userPrompt = "Review <ocra_review_files>src/a.ts</ocra_review_files>.",
): AgentTaskSpec {
  return {
    taskId: "t1",
    reviewer: "correctness",
    modelTier: "standard",
    systemPrompt: "You review code with the tools given.",
    userPrompt,
    context: fakeContext(),
    timeoutMs: 30_000,
  };
}

async function record(dir: string, script: readonly Reply[], userPrompt?: string) {
  const live = await scriptedEndpoint(script);
  servers.push(live);
  const events = await collect(
    runtime(live.url, { [RECORD_DIR_ENV]: dir }).runTask(
      spec(userPrompt),
      new AbortController().signal,
    ),
  );
  return { live, events };
}

async function replay(dir: string, userPrompt?: string) {
  const server = await replayEndpoint(dir);
  servers.push(server);
  const events = await collect(
    runtime(server.url).runTask(spec(userPrompt), new AbortController().signal),
  );
  return { server, events };
}

// What a run reports, without what differs between two runs of it.
const reported = (events: readonly AgentEvent[]) => events.filter((e) => e.type !== "progress");

describe("recording the direct runtime's model exchanges", () => {
  it("replays a recorded run to the same findings, usage and end, with no live endpoint", async () => {
    const dir = tempDir();
    const { live, events } = await record(dir, [
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { toolCalls: [{ name: "report_finding", args: FINDING }] },
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    await live.close();
    expect(readdirSync(dir)).toHaveLength(3);

    const { server, events: replayed } = await replay(dir);
    expect(server.misses).toEqual([]);
    expect(reported(replayed)).toEqual(reported(events));
    expect(replayed.at(-1)).toEqual({ type: "done", taskId: "t1" });
  });

  it("says a run whose prompt changed is not replayable", async () => {
    const dir = tempDir();
    await record(dir, [{ content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] }]);

    const { server, events } = await replay(dir, "Review src/b.ts instead.");
    expect(server.misses).toHaveLength(1);
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ type: "error" });
    expect(JSON.stringify(error)).toContain("not replayable");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  it("serves a request sent twice the answers it got, in order", async () => {
    const dir = tempDir();
    // A 503 is sent once more: the same request, two answers.
    await record(dir, [
      { status: 503, body: '{"error":{"message":"overloaded"}}' },
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    expect(readdirSync(dir)).toHaveLength(1);

    const { server, events } = await replay(dir);
    expect(server.misses).toEqual([]);
    expect(server.seen).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
  });

  it("writes no key, header or endpoint address, and only for its owner", async () => {
    const dir = tempDir();
    const { live } = await record(dir, [
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { status: 500, body: `{"error":{"message":"bad key ${KEY}"}}` },
      { content: `Echoed ${KEY}.`, toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    const files = readdirSync(dir);
    expect(files.length).toBeGreaterThan(0);
    const written = files.map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(written).toContain("Echoed");
    expect(written).toContain("bad key");
    expect(written).not.toContain(KEY);
    expect(written.toLowerCase()).not.toContain("authorization");
    expect(written).not.toContain(live.url);
    for (const file of files) expect(statSync(join(dir, file)).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it("leaves out a key renewed during the run and a key with quotes or backslashes", async () => {
    const dir = tempDir();
    // A live environment, as the CLI passes for the ocra Cloud token it renews.
    let key = 'sk-first-"quoted\\slashed-secret';
    const env = {
      [RECORD_DIR_ENV]: dir,
      get LOCAL_KEY() {
        return key;
      },
    };
    const live = await scriptedEndpoint((request) => ({
      content: `Echoed ${request.authorization ?? ""} in ${request.messages.length}.`,
      toolCalls: [{ name: "task_done", args: {} }],
    }));
    servers.push(live);
    const direct = runtimeWith(live.url, env);
    const signal = new AbortController().signal;
    await collect(direct.runTask(spec(), signal));
    const first = key;
    key = "sk-renewed-secret";
    await collect(direct.runTask(spec("Review src/b.ts."), signal));
    expect(live.seen.map((s) => s.authorization)).toEqual([`Bearer ${first}`, `Bearer ${key}`]);

    const written = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), "utf8"))
      .join("\n");
    expect(written).toContain("Echoed");
    expect(written).not.toContain("slashed-secret");
    expect(written).not.toContain("renewed");
  });

  it("goes on without a recording it cannot write, sending each request once", async () => {
    const dir = tempDir();
    const live = await scriptedEndpoint([
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    servers.push(live);
    const direct = runtime(live.url, { [RECORD_DIR_ENV]: dir });
    // The directory is gone and a file holds its name, so no write can land.
    rmSync(dir, { recursive: true });
    writeFileSync(dir, "");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const events = await collect(direct.runTask(spec(), new AbortController().signal));
      expect(live.seen).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
      expect(stderr.mock.calls.map(([text]) => String(text)).join("")).toContain(RECORD_DIR_ENV);
    } finally {
      stderr.mockRestore();
    }
  });

  it("goes on without a recording whose earlier file is not a recording", async () => {
    const dir = tempDir();
    await record(dir, [{ content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] }]);
    const [file] = readdirSync(dir);
    writeFileSync(join(dir, file as string), '{"version":1,"answers":"none"}');
    const live = await scriptedEndpoint([
      { content: "Reviewed.", toolCalls: [{ name: "task_done", args: {} }] },
    ]);
    servers.push(live);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const events = await collect(
        runtime(live.url, { [RECORD_DIR_ENV]: dir }).runTask(spec(), new AbortController().signal),
      );
      expect(live.seen).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: "done", taskId: "t1" });
    } finally {
      stderr.mockRestore();
    }
  });

  it("refuses a recording directory it cannot create, before any request", () => {
    // A path under a regular file cannot be a directory.
    const file = join(tempDir(), "a-file");
    writeFileSync(file, "");
    const blocked = join(file, "below");
    expect(() => runtime("http://127.0.0.1:1/v1", { [RECORD_DIR_ENV]: blocked })).toThrow(
      RECORD_DIR_ENV,
    );
  });
});

describe("the recorded fixture of a task that stops early", () => {
  it.runIf(process.env.OCRA_RERECORD === "1")("is recorded again", async () => {
    rmSync(STOPPED_EARLY, { recursive: true, force: true });
    await record(STOPPED_EARLY, [
      { toolCalls: [{ name: "read_file", args: { path: "src/a.ts" } }] },
      { content: "The change looks correct; nothing to report." },
    ]);
  });

  it("replays to a task that ended without task_done", async () => {
    const { server, events } = await replay(STOPPED_EARLY);
    expect(server.misses).toEqual([]);
    expect(events.at(-1)).toEqual({ type: "done", taskId: "t1", ended: "stopped_early" });
    expect(events.some((e) => e.type === "finding")).toBe(false);
  });
});
