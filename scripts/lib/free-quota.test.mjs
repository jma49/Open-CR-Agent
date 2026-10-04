import { describe, expect, it } from "vitest";
import { freeRequestsLeft, probeLine, probeRequest } from "./free-quota.mjs";

describe("freeRequestsLeft", () => {
  it("reads the rate-limit header", () => {
    expect(freeRequestsLeft(new Headers({ "X-RateLimit-Remaining": "321" }), "{}")).toBe("321");
  });

  it("takes the last of a header sent twice", () => {
    const headers = new Headers();
    headers.append("x-ratelimit-remaining", "5");
    headers.append("x-ratelimit-remaining", "4");
    expect(freeRequestsLeft(headers, "")).toBe("4");
  });

  it("reads the count a per-day 429 copies into its error", () => {
    const body = JSON.stringify({
      error: {
        message: "Rate limit exceeded: free-models-per-day",
        metadata: { headers: { "X-RateLimit-Remaining": "0" } },
      },
    });
    expect(freeRequestsLeft(new Headers(), body)).toBe("0");
  });

  it("says nothing when OpenRouter does not", () => {
    expect(freeRequestsLeft(new Headers(), "")).toBeUndefined();
    expect(freeRequestsLeft(new Headers(), "not json")).toBeUndefined();
    const other = JSON.stringify({
      error: { message: "per-minute", metadata: { headers: { "X-RateLimit-Remaining": "0" } } },
    });
    expect(freeRequestsLeft(new Headers(), other)).toBeUndefined();
  });
});

describe("probeLine", () => {
  it("logs the status, the rate-limit headers and the count", () => {
    const headers = new Headers({ "x-ratelimit-limit": "1000", "x-ratelimit-remaining": "9" });
    expect(probeLine({ status: 200, statusText: "OK" }, headers, "9")).toBe(
      "Free model probe: HTTP 200 OK; x-ratelimit-limit: 1000 x-ratelimit-remaining: 9 left: 9",
    );
    expect(probeLine(undefined, new Headers(), undefined)).toBe(
      "Free model probe: no answer; left: not reported",
    );
  });
});

describe("probeRequest", () => {
  it("asks for one token", () => {
    expect(probeRequest("m")).toEqual({
      model: "m",
      max_tokens: 1,
      messages: [{ role: "user", content: "ok" }],
    });
  });
});
