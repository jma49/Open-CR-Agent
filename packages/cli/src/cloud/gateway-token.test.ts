import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";
import { GatewayToken, RENEW_BEFORE_MS } from "./gateway-token.js";

const SERVER = "https://cloud.test";
const tokens: GatewayToken[] = [];
afterEach(() => {
  for (const token of tokens.splice(0)) token.stop();
});

// A saved session whose token is due for renewal in `dueInMs`.
function machine(refresh: () => Response, dueInMs: number) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-gateway-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  const saved: Credentials = {
    server: SERVER,
    login: "octo",
    access_token: "ocra_cli_first",
    refresh_token: "ocra_ref_1",
    expires_at: Date.now() + RENEW_BEFORE_MS + dueInMs,
  };
  mkdirSync(join(dir, "ocra"));
  writeFileSync(credentialsPath, JSON.stringify(saved));
  let refreshes = 0;
  const deps: CloudDeps = {
    env: {},
    fetch: (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname !== "/api/device/refresh") {
        return new Response("{}", { status: 404 });
      }
      refreshes += 1;
      return refresh();
    }) as typeof fetch,
    now: Date.now,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
  const warnings: string[] = [];
  const token = new GatewayToken(saved, deps, (m) => warnings.push(m));
  tokens.push(token);
  return { token, warnings, refreshes: () => refreshes };
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i += 1) await new Promise((r) => setTimeout(r, 10));
}

describe("the gateway token during a run", () => {
  it("is renewed before it expires, and the renewed one is what the run reads", async () => {
    const pair = () =>
      Response.json({
        access_token: "ocra_cli_next",
        refresh_token: "ocra_ref_2",
        expires_in: 3600,
      });
    const m = machine(pair, 30);
    m.token.start();
    expect(m.token.value).toBe("ocra_cli_first");
    await until(() => m.token.value !== "ocra_cli_first");
    expect(m.token.value).toBe("ocra_cli_next");
    expect(m.refreshes()).toBe(1);
    expect(m.warnings).toEqual([]);
  });

  it("warns once when it cannot be renewed, without the token, and stops with the run", async () => {
    const m = machine(() => new Response("{}", { status: 503 }), 0);
    m.token.start();
    await until(() => m.warnings.length > 0);
    expect(m.warnings).toEqual([
      "could not renew the ocra Cloud token (HTTP 503); model calls through ocra Cloud fail once it expires",
    ]);
    expect(m.warnings.join(" ")).not.toContain("ocra_cli_first");
    expect(m.token.value).toBe("ocra_cli_first");

    const stopped = machine(() => new Response("{}", { status: 503 }), 30);
    stopped.token.start();
    stopped.token.stop();
    await new Promise((r) => setTimeout(r, 80));
    expect(stopped.refreshes()).toBe(0);
  });
});
