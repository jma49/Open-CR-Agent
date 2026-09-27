import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { createUntimedDispatcher, untimedFetch } from "./transport.js";

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

// Sends headers at once and the body only after `delayMs`, like OpenCode
// answering a prompt when the agent has finished.
async function slowServer(delayMs: number): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.flushHeaders();
      setTimeout(() => res.end(JSON.stringify({ method: req.method, body })), delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

describe("untimedFetch", () => {
  // undici checks its timeouts about once a second, hence the long delay.
  it("waits for a slow body that a body timeout would cut off", { timeout: 15_000 }, async () => {
    const url = await slowServer(2_500);
    const timed = untimedFetch(new Agent({ bodyTimeout: 500 }));
    await expect(timed(url).then((r) => r.text())).rejects.toThrow();

    const response = await untimedFetch(createUntimedDispatcher())(
      new Request(url, { method: "POST", body: '{"a":1}' }),
    );
    expect(await response.json()).toEqual({ method: "POST", body: '{"a":1}' });
  });

  it("still honours the request's abort signal", async () => {
    const url = await slowServer(5_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(
      untimedFetch(createUntimedDispatcher())(url, { signal: controller.signal }).then((r) =>
        r.text(),
      ),
    ).rejects.toThrow();
  });
});
