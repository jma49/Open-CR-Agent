import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeRuntime, openCodeConfig } from "./runtime.js";

// An OpenAI-compatible chat endpoint on this machine that answers "Done."
// and reports 1,000 input and 10 output tokens.
async function fakeEndpoint() {
  const authorizations: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      authorizations.push(req.headers.authorization ?? "");
      const { model, stream } = JSON.parse(body) as { model: string; stream?: boolean };
      const usage = { prompt_tokens: 1_000, completion_tokens: 10, total_tokens: 1_010 };
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      if (!stream) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "c",
            object: "chat.completion",
            created: 1,
            model,
            choices: [
              { index: 0, message: { role: "assistant", content: "Done." }, finish_reason: "stop" },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "Done." }, null));
      res.write(chunk({}, "stop", { usage }));
      res.end("data: [DONE]\n\n");
    });
  });
  return { ...(await listen(server)), authorizations };
}

// A proxy that refuses every request, standing in for no network at all,
// and records where each one was going.
async function refusingProxy() {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    req.socket.on("error", () => {});
    seen.push(req.url ?? "");
    res.writeHead(403).end();
  });
  server.on("connect", (req, socket) => {
    socket.on("error", () => {});
    seen.push(req.url ?? "");
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  return { ...(await listen(server)), seen };
}

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push(server);
  return { url: `http://127.0.0.1:${port}` };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("a provider declared in configuration", () => {
  it("reaches an OpenAI-compatible endpoint with the key from the environment, priced, and nothing but the pricing catalog", async () => {
    const endpoint = await fakeEndpoint();
    const proxy = await refusingProxy();
    const caches = await mkdtemp(join(tmpdir(), "ocra-caches-"));
    const runtime = new OpenCodeRuntime({
      models: { light: ["local/m1"] },
      tools: [],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LOCAL_KEY: "sk-local-secret",
        // Empty caches, so that OpenCode cannot answer from what an earlier
        // run left behind: its catalog and any npm package must be asked for.
        OCRA_RUNTIME_ENV: "XDG_CACHE_HOME,npm_config_cache",
        XDG_CACHE_HOME: join(caches, "xdg"),
        npm_config_cache: join(caches, "npm"),
        HTTP_PROXY: proxy.url,
        HTTPS_PROXY: proxy.url,
        http_proxy: proxy.url,
        https_proxy: proxy.url,
        NO_PROXY: "127.0.0.1",
        no_proxy: "127.0.0.1",
      },
      providers: {
        local: {
          baseUrl: `${endpoint.url}/v1`,
          apiKeyEnv: "LOCAL_KEY",
          models: { m1: { input: 3, output: 15 } },
        },
      },
    });
    try {
      const result = await runtime.complete(
        { tier: "light", system: "Answer in one word.", user: "Are you there?", timeoutMs: 60_000 },
        AbortSignal.timeout(90_000),
      );
      expect(result.text).toContain("Done.");
      // 1,000 input tokens at $3 and 10 output tokens at $15 per million.
      expect(result.usage.costUsd).toBeCloseTo(0.00315, 8);
      expect(endpoint.authorizations.length).toBeGreaterThan(0);
      expect(endpoint.authorizations.every((a) => a === "Bearer sk-local-secret")).toBe(true);
    } finally {
      await runtime.dispose();
      await rm(caches, { recursive: true, force: true });
    }
    // The proxy is on OpenCode's path: the pricing catalog went there. Nothing
    // else did, because npm installs go to a registry that refuses on this
    // machine (server-env.ts).
    expect(proxy.seen.some((to) => to.startsWith("models.opencode.ai"))).toBe(true);
    expect(proxy.seen.filter((to) => !to.startsWith("models.opencode.ai"))).toEqual([]);
  }, 90_000);

  it("keeps the key itself out of OpenCode's configuration", () => {
    const config = openCodeConfig(
      { url: "http://127.0.0.1:1/mcp", headers: {} },
      {},
      {
        gateway: {
          baseUrl: "https://llm.example.com/v1",
          apiKeyEnv: "GATEWAY_KEY",
          models: { m1: { input: 3, output: 15, cachedInput: 0.3 } },
        },
      },
    );
    expect(config.provider).toEqual({
      gateway: {
        npm: "@ai-sdk/openai-compatible",
        name: "gateway",
        options: { baseURL: "https://llm.example.com/v1", apiKey: "{env:GATEWAY_KEY}" },
        models: { m1: { name: "m1", cost: { input: 3, output: 15, cache_read: 0.3 } } },
      },
    });
  });
});
