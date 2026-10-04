import { describe, expect, it } from "vitest";
import { type PlatformApi, type PlatformCall, sendWithRetry } from "./http.js";

function request(answers: Array<Response | Error>, overrides: Partial<PlatformCall> = {}) {
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
});
