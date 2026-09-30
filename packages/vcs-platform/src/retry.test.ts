import { describe, expect, it } from "vitest";
import { retryDecision } from "./retry.js";

const answer = (status: number, headers: Record<string, string> = {}, body = "") => ({
  status,
  headers: new Headers(headers),
  body,
});

describe("retryDecision", () => {
  it("does not retry a plain 403", () => {
    expect(retryDecision("GET", true, answer(403, {}, "Forbidden"), 1).retry).toBe(false);
  });

  it("caps the wait for a rate limit reset", () => {
    const limited = answer(429, { "x-ratelimit-reset": "5000" });
    expect(retryDecision("GET", true, limited, 1, 0).waitMs).toBe(60_000);
  });

  it("waits for GitLab's rate limit reset too", () => {
    const limited = answer(429, { "ratelimit-reset": "12" });
    expect(retryDecision("POST", false, limited, 1, 10_000)).toEqual({
      retry: true,
      waitMs: 2_000,
    });
  });

  it("retries a request that may have acted only when it is safe to repeat", () => {
    expect(retryDecision("POST", false, answer(502), 1).retry).toBe(false);
    expect(retryDecision("PUT", true, answer(502), 1)).toEqual({ retry: true, waitMs: 1_000 });
    expect(retryDecision("POST", false, "network_error", 1).retry).toBe(false);
    expect(retryDecision("GET", true, "network_error", 2)).toEqual({ retry: true, waitMs: 2_000 });
    expect(retryDecision("GET", true, answer(502), 3).retry).toBe(false);
  });
});
