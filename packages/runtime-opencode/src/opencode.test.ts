import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOpencodeBinary } from "./binary.js";
import { startOpencodeServer } from "./opencode-server.js";
import { OPENCODE_BUILTIN_TOOLS, OpenCodeRuntime } from "./runtime.js";
import { serverEnv } from "./server-env.js";

describe("OpenCode binary", () => {
  it("starts with a password and exposes only built-in tools we disable", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-opencode-test-"));
    const dirs = { config: join(root, "c"), data: join(root, "d"), state: join(root, "s") };
    const server = await startOpencodeServer({
      binary: resolveOpencodeBinary(process.env),
      env: serverEnv(process.env, dirs, []),
      config: { share: "disabled", autoupdate: false },
    });
    try {
      const url = `${server.url}/experimental/tool/ids?directory=${encodeURIComponent(root)}`;
      expect((await fetch(url)).status).toBe(401);
      const ids = (await (
        await fetch(url, { headers: { Authorization: server.authorization } })
      ).json()) as string[];
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
