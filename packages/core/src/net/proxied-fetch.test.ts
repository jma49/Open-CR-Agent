import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { proxiedFetch } from "./proxied-fetch.js";

// A forward proxy that answers every request itself and records where it
// was going; a target that only it can "reach".
async function forwardProxy() {
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "text/plain" }).end("via proxy");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  servers.push(server);
  return { url: `http://127.0.0.1:${port}`, seen };
}

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const TARGET = "http://model.invalid/v1/chat/completions";

describe("proxiedFetch", () => {
  it("sends requests through the proxy the environment names, with their body and headers", async () => {
    const proxy = await forwardProxy();
    const fetch = proxiedFetch({ HTTPS_PROXY: proxy.url, http_proxy: proxy.url });
    const response = await fetch(TARGET, {
      method: "POST",
      headers: { authorization: "Bearer k" },
      body: "{}",
    });
    expect(await response.text()).toBe("via proxy");
    expect(proxy.seen).toEqual([`POST ${TARGET}`]);
  });

  it("goes direct for hosts in NO_PROXY", async () => {
    const proxy = await forwardProxy();
    const fetch = proxiedFetch({ HTTP_PROXY: proxy.url, NO_PROXY: "model.invalid" });
    await expect(fetch(TARGET)).rejects.toThrow();
    expect(proxy.seen).toEqual([]);
  });

  it("is Node's fetch when no proxy is set", () => {
    expect(proxiedFetch({})).toBe(fetch);
  });
});
