import { describe, expect, it } from "vitest";
import { type PlatformApi, type PlatformCall, sendWithRetry } from "./http.js";

function request(
  answers: Array<Response | Error>,
  overrides: Partial<PlatformCall> = {},
  setup: Partial<PlatformApi> = {},
) {
  const seen: RequestInit[] = [];
  const waits: number[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer left");
    if (next instanceof Error) throw next;
    return next;
  };
  const api: PlatformApi = {
    platform: "Forge",
    headers: { Authorization: "Bearer t" },
    fetch,
    sleep: async (ms) => {
      waits.push(ms);
    },
    timeoutMs: () => 1_000,
    toError: (status, message) => Object.assign(new Error(message), { status }),
    ...setup,
  };
  const call: PlatformCall = { method: "GET", url: "https://forge.test/api/x", path: "/x?page=2" };
  return { send: () => sendWithRetry(api, { ...call, ...overrides }), seen, waits };
}

describe("sendWithRetry", () => {
  it("sends JSON with the platform's headers and ocra's user agent", async () => {
    const { send, seen } = request([Response.json({ ok: 1 })], {
      method: "POST",
      body: { a: 1 },
    });
    expect(await send()).toEqual({ ok: 1 });
    expect(seen[0]?.body).toBe('{"a":1}');
    expect(seen[0]?.headers).toEqual({
      Authorization: "Bearer t",
      "User-Agent": "open-cr-agent",
      "Content-Type": "application/json",
    });
  });

  it("answers undefined for a 204", async () => {
    const { send } = request([new Response(null, { status: 204 })]);
    expect(await send()).toBeUndefined();
  });

  it("retries an outage and a lost connection of a request safe to repeat", async () => {
    const { send, waits } = request([
      new Response("down", { status: 502 }),
      new Error("reset"),
      Response.json([]),
    ]);
    expect(await send()).toEqual([]);
    expect(waits).toEqual([1_000, 2_000]);
  });

  it("does not repeat a POST whose connection was lost", async () => {
    const { send, seen } = request([new Error("reset")], { method: "POST" });
    await expect(send()).rejects.toThrow("reset");
    expect(seen).toHaveLength(1);
  });

  it("repeats a POST that is safe to repeat", async () => {
    const { send } = request([new Error("reset"), Response.json({})], {
      method: "POST",
      idempotent: true,
    });
    expect(await send()).toEqual({});
  });

  it("names the request and quotes at most 500 characters of a refusal", async () => {
    const { send } = request([new Response("x".repeat(600), { status: 404 })]);
    await expect(send()).rejects.toMatchObject({
      status: 404,
      message: `Forge GET /x failed with 404: ${"x".repeat(500)}`,
    });
  });

  it("reads a refusal's answer only up to a bound", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(120);
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 8 * 1024 * 1024) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const { send } = request([new Response(endless, { status: 404 })]);
    await expect(send()).rejects.toMatchObject({ status: 404 });
    expect(sent).toBeLessThanOrEqual(128 * 1024);
  });

  it("still finds a rate limit named past the quoted part of a refusal", async () => {
    const { send } = request([
      new Response(`${"x".repeat(600)} secondary rate limit`, { status: 403 }),
      Response.json({}),
    ]);
    expect(await send()).toEqual({});
  });

  it("stops waiting for a retry once the caller aborts", async () => {
    const controller = new AbortController();
    const limited = new Response("slow down", { status: 429, headers: { "retry-after": "5" } });
    const { send } = request(
      [limited, Response.json({})],
      {},
      {
        sleep: undefined,
        signal: controller.signal,
      },
    );
    const sent = send().then(
      () => "answered",
      (error: unknown) => (error === controller.signal.reason ? "aborted" : error),
    );
    setTimeout(() => controller.abort(), 20);
    const outcome = await Promise.race([
      sent,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 500)),
    ]);
    expect(outcome).toBe("aborted");
  });

  it("sends nothing more once the caller aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { send, seen } = request(
      [new Error("reset"), Response.json({})],
      {},
      {
        signal: controller.signal,
      },
    );
    await expect(send()).rejects.toBe(controller.signal.reason);
    expect(seen).toHaveLength(0);
  });
});
