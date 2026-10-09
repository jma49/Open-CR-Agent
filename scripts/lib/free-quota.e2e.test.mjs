import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { freeRequestsLeft, probeFailure, probeLine, probeRequest } from "./free-quota.mjs";

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

describe("probeFailure", () => {
  it("names a model OpenRouter no longer serves", () => {
    expect(probeFailure("vendor/gone:free", { status: 404 })).toBe(
      "::error title=Free model gone::OpenRouter no longer serves vendor/gone:free (HTTP 404); replace it with a current free model",
    );
  });

  it("names a zero-price model that needs credits on the account", () => {
    expect(probeFailure("vendor/paid-pool", { status: 402 })).toBe(
      "::error title=Free model needs credits::vendor/paid-pool needs OpenRouter credits on the account (HTTP 402 Payment Required)",
    );
  });

  it("lets every other answer through, a spent quota and no answer included", () => {
    for (const status of [200, 429, 500]) expect(probeFailure("m/x", { status })).toBeUndefined();
    expect(probeFailure("m/x", undefined)).toBeUndefined();
  });
});

// The script with fetch answering FAKE_STATUS, so no request leaves the test.
const FAKE_FETCH = `data:text/javascript,globalThis.fetch = async () => new Response("{}", { status: Number(process.env.FAKE_STATUS), headers: { "x-ratelimit-remaining": "9" } });`;
// fetch answering a 429 of 8 MB that counts what was read of it.
const LONG_ANSWER = `data:text/javascript,let sent = 0; process.on("exit", () => process.stderr.write("sent " + sent + "\\n")); const chunk = new Uint8Array(16384).fill(32); globalThis.fetch = async () => new Response(new ReadableStream({ pull(c) { if (sent >= 8388608) return c.close(); sent += chunk.length; c.enqueue(chunk); } }), { status: 429 });`;
/**
 * @param {number} status
 * @param {string} fake
 */
function runProbe(status, fake = FAKE_FETCH) {
  const script = fileURLToPath(new URL("../free-quota.mjs", import.meta.url));
  return spawnSync(process.execPath, ["--import", fake, script, "vendor/m:free"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, OPENROUTER_API_KEY: "k", FAKE_STATUS: String(status) },
  });
}

describe("the probe script", () => {
  it("fails, naming the model, when OpenRouter no longer serves it or wants credits", () => {
    for (const [status, says] of [
      [404, "OpenRouter no longer serves vendor/m:free"],
      [402, "vendor/m:free needs OpenRouter credits"],
    ]) {
      const run = runProbe(Number(status));
      expect(run.status, String(status)).toBe(1);
      expect(run.stderr).toContain(`::error title=`);
      expect(run.stderr).toContain(says);
      expect(run.stdout).toBe("");
    }
  });

  it("reads no more than 64 KB of the answer", () => {
    const run = runProbe(429, LONG_ANSWER);
    expect(run.status).toBe(0);
    const sent = Number(/sent (\d+)/.exec(run.stderr)?.[1]);
    expect(sent).toBeLessThanOrEqual(128 * 1024);
  });

  it("prints the count of an answer that has one", () => {
    const run = runProbe(200);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("9\n");
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
