import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpencodeBinary } from "./binary.js";
import { type OpencodeServer, startOpencodeServer } from "./opencode-server.js";
import { OPENCODE_BUILTIN_TOOLS, OpenCodeRuntime } from "./runtime.js";
import { serverEnv } from "./server-env.js";

describe("OpenCode binary", () => {
  it("starts with a password and exposes only built-in tools we disable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-opencode-test-"));
    const dirs = { config: join(root, "c"), data: join(root, "d"), state: join(root, "s") };
    const server = await startOpencodeServer({
      binary: resolveOpencodeBinary(process.env),
      cwd: root,
      env: serverEnv(process.env, dirs, []),
      config: { share: "disabled", autoupdate: false },
    });
    try {
      const url = `${server.url}/experimental/tool/ids?directory=${encodeURIComponent(root)}`;
      expect((await fetch(url)).status).toBe(401);
      const ids = (await (
        await fetch(url, { headers: { Authorization: server.authorization } })
      ).json()) as string[];
      // An empty or broken answer must not pass as "nothing new".
      expect(ids).toEqual(expect.arrayContaining(["bash", "edit", "write", "webfetch"]));
      expect(
        ids.filter((id) => !(OPENCODE_BUILTIN_TOOLS as readonly string[]).includes(id)),
      ).toEqual([]);
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("OpenCodeRuntime", () => {
  it("runs OpenCode in its own empty workspace, not in the directory ocra runs in", async () => {
    const runtime = new OpenCodeRuntime({ models: {}, tools: [], env: process.env });
    try {
      const infra = await (
        runtime as unknown as { start(): Promise<{ root: string; server: OpencodeServer }> }
      ).start();
      // Without a directory, OpenCode answers for the directory it runs in.
      const answer = await fetch(`${infra.server.url}/path`, {
        headers: { Authorization: infra.server.authorization },
      });
      const { directory } = (await answer.json()) as { directory: string };
      expect(directory).toBe(realpathSync(join(infra.root, "workspace")));
    } finally {
      await runtime.dispose();
    }
  }, 60_000);

  it("stops OpenCode and removes its directory even when the process exits before dispose", async () => {
    const runtime = new OpenCodeRuntime({ models: {}, tools: [], env: process.env });
    const before = process.listenerCount("exit");
    const infra = await (
      runtime as unknown as { start(): Promise<{ root: string; onExit(): void }> }
    ).start();
    expect(process.listenerCount("exit")).toBe(before + 1);
    // What a second Ctrl-C (process.exit) runs.
    infra.onExit();
    expect(existsSync(infra.root)).toBe(false);
    await runtime.dispose();
    expect(process.listenerCount("exit")).toBe(before);
  }, 60_000);

  it("fails a task with a clear message when its tier has no model, without starting OpenCode", async () => {
    const runtime = new OpenCodeRuntime({
      models: {},
      tools: [],
      env: {},
      binary: "/nonexistent/opencode",
    });
    const context = {
      readFile: async () => undefined,
      readDiff: () => undefined,
      searchCode: async () => [],
    };
    const events = [];
    for await (const event of runtime.runTask(
      {
        taskId: "t",
        reviewer: "r",
        modelTier: "standard",
        systemPrompt: "s",
        userPrompt: "u",
        context,
        timeoutMs: 1000,
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      {
        type: "error",
        taskId: "t",
        retryable: false,
        error:
          'No model configured for the "standard" tier; set models.standard in .ocra/config.json or OCRA_MODEL_STANDARD',
      },
    ]);
    await runtime.dispose();
  });
});
