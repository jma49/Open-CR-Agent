import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { errorMessage, isOcraError } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import type { Credentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";
import { CLOUD_TOKEN_ENV, withCloudProviders } from "./providers.js";

const SERVER = "https://cloud.test";
const NOW = 1_000_000_000;
const listing = {
  providers: [
    { name: "openrouter", paths: ["/v1/chat/completions", "/v1/responses", "/v1/messages"] },
    {
      name: "deepseek",
      paths: ["/chat/completions", "/v1/chat/completions", "/anthropic/v1/messages"],
    },
    { name: "kimi-coding", paths: ["/v1/messages"] },
  ],
};

function setup(
  saved?: Partial<Credentials>,
  env: Record<string, string> = {},
  providersAnswer: () => Response = () => Response.json(listing),
) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-cloudp-"));
  const path = join(dir, "ocra", "credentials.json");
  if (saved) {
    mkdirSync(join(dir, "ocra"));
    writeFileSync(
      path,
      JSON.stringify({
        server: SERVER,
        login: "octo",
        access_token: "ocra_cli_live",
        refresh_token: "ocra_ref_1",
        expires_at: NOW + 3_600_000,
        ...saved,
      }),
    );
  }
  const calls: string[] = [];
  const deps: CloudDeps = {
    env,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/api/providers") return providersAnswer();
      if (url.pathname === "/api/device/refresh") {
        return Response.json({
          access_token: "ocra_cli_new",
          refresh_token: "ocra_ref_2",
          expires_in: 3600,
        });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    now: () => NOW,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath: path,
    clientName: "t",
  };
  const warnings: string[] = [];
  return { deps, calls, warnings, warn: (m: string) => warnings.push(m), env };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

describe("models through ocra Cloud", () => {
  it("leaves a review without ocra- models alone: no session read, no request", async () => {
    const t = setup(undefined);
    const out = await withCloudProviders(
      [["google/gemini-3.5-flash"]],
      {},
      { A: "1" },
      t.deps,
      t.warn,
    );
    expect(out).toMatchObject({ providers: {}, env: { A: "1" } });
    expect(t.calls).toEqual([]);
  });

  it("declares each named provider as a gateway endpoint with the session's token", async () => {
    const t = setup({});
    const out = await withCloudProviders(
      [
        ["ocra-openrouter/qwen/qwen3.8-27b:free", "ocra-deepseek/deepseek-chat"],
        ["ocra-openrouter/liquid/lfm-2.5-2.6b:free"],
      ],
      {},
      {},
      t.deps,
      t.warn,
    );
    expect(out.providers["ocra-openrouter"]).toEqual({
      baseUrl: `${SERVER}/api/gateway/openrouter/v1`,
      apiKeyEnv: CLOUD_TOKEN_ENV,
      models: {
        "qwen/qwen3.8-27b:free": { input: 0, output: 0 },
        "liquid/lfm-2.5-2.6b:free": { input: 0, output: 0 },
      },
    });
    expect(out.providers["ocra-deepseek"]?.baseUrl).toBe(`${SERVER}/api/gateway/deepseek`);
    expect(out.env[CLOUD_TOKEN_ENV]).toBe("ocra_cli_live");
    expect(t.warnings.join("")).toContain("not priced");
    expect(t.calls).toEqual(["GET /api/providers"]);
  });

  it("drops model ids and gateway paths ocra Cloud may not name, with a warning", async () => {
    const t = setup({});
    const odd = {
      providers: [
        { name: "openrouter", paths: ["/v1{x}/chat/completions", "/v1/chat/completions"] },
        { name: "deepseek", paths: ["/a b/chat/completions"] },
      ],
    };
    const fetchListing = t.deps.fetch;
    t.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/providers"
        ? Response.json(odd)
        : fetchListing(input, init)) as typeof fetch;
    const out = await withCloudProviders(
      [["ocra-openrouter/m{1}", "ocra-openrouter/m1", "ocra-g{w}/m", "ocra-Gw/m"]],
      {},
      {},
      t.deps,
      t.warn,
    );
    const config = JSON.stringify(out.providers);
    for (const odd of ["m{1}", "g{w}", "Gw", "v1{x}"]) expect(config).not.toContain(odd);
    expect(Object.keys(out.providers)).toEqual(["ocra-openrouter"]);
    expect(out.providers["ocra-openrouter"]).toMatchObject({
      baseUrl: `${SERVER}/api/gateway/openrouter/v1`,
      models: { m1: { input: 0, output: 0 } },
    });
    expect(t.warnings.join("\n")).toContain('"ocra-openrouter/m{1}"');
    expect(t.warnings.join("\n")).toContain("not plain paths");

    const e = await failure(withCloudProviders([["ocra-deepseek/m"]], {}, {}, t.deps, t.warn));
    expect(isOcraError(e) && e.code).toBe("CONFIG_INVALID");
  });

  it("asks a runtime that reads the token once for one that outlives the run, and warns when none can", async () => {
    const t = setup({});
    const twoHours = { timeoutMs: 120 * 60_000, keyReadPerCall: false };
    const out = await withCloudProviders([["ocra-openrouter/m"]], {}, {}, t.deps, t.warn, twoHours);
    expect(t.calls[0]).toBe("POST /api/device/refresh");
    expect(out.env[CLOUD_TOKEN_ENV]).toBe("ocra_cli_new");
    expect(t.warnings.join("\n")).toContain(
      "this run may last 120 minutes, but its runtime reads the ocra Cloud token once and the token lasts 60",
    );
  });

  it("hands a runtime that reads the token at each call the renewed one", async () => {
    const t = setup({});
    const out = await withCloudProviders([["ocra-openrouter/m"]], {}, {}, t.deps, t.warn, {
      timeoutMs: 120 * 60_000,
      keyReadPerCall: true,
    });
    out.stop();
    expect(t.calls).toEqual(["GET /api/providers"]);
    expect(out.env[CLOUD_TOKEN_ENV]).toBe("ocra_cli_live");
    expect(t.warnings.join("\n")).not.toContain("reads the ocra Cloud token once");
  });

  it("refreshes a token that would expire during the review", async () => {
    const t = setup({ expires_at: NOW + 10 * 60_000 });
    const out = await withCloudProviders([["ocra-openrouter/m"]], {}, {}, t.deps, t.warn);
    expect(out.env[CLOUD_TOKEN_ENV]).toBe("ocra_cli_new");
    expect(t.calls[0]).toBe("POST /api/device/refresh");
  });

  it("keeps a provider the configuration declares itself", async () => {
    const t = setup(undefined);
    const own = {
      "ocra-mine": { baseUrl: "https://mine.example/v1", models: { m: { input: 1, output: 2 } } },
    };
    const out = await withCloudProviders([["ocra-mine/m"]], own, {}, t.deps, t.warn);
    expect(out.providers).toEqual(own);
    expect(t.calls).toEqual([]);
  });

  it("asks to sign in, refuses with ocra Cloud off, and names providers without a chat endpoint", async () => {
    const signedOut = setup(undefined);
    const e1 = await failure(
      withCloudProviders([["ocra-openrouter/m"]], {}, {}, signedOut.deps, signedOut.warn),
    );
    expect(isOcraError(e1) && e1.code).toBe("CONFIG_CREDENTIALS_MISSING");
    expect(String(e1)).toContain("ocra login");

    const off = setup({});
    const e2 = await failure(
      withCloudProviders([["ocra-openrouter/m"]], {}, { OCRA_CLOUD: "off" }, off.deps, off.warn),
    );
    expect(isOcraError(e2) && e2.code).toBe("CONFIG_INVALID");
    expect(off.calls).toEqual([]);

    const t = setup({});
    for (const model of ["ocra-kimi-coding/kimi", "ocra-nope/m"]) {
      const e = await failure(withCloudProviders([[model]], {}, {}, t.deps, t.warn));
      expect(isOcraError(e) && e.code).toBe("CONFIG_INVALID");
    }
  });

  it("refuses a providers answer that is not a list, with an ocra error, not a crash", async () => {
    for (const answer of [
      () => new Response("<html>"),
      () => Response.json({ providers: "all" }),
    ]) {
      const t = setup({}, {}, answer);
      const e = await failure(withCloudProviders([["ocra-openrouter/m"]], {}, {}, t.deps, t.warn));
      expect(isOcraError(e) && e.code).toBe("RUNTIME_START_FAILED");
      expect(errorMessage(e)).toContain("not a list of providers");
    }
    const odd = setup({}, {}, () =>
      Response.json({ providers: [{ name: "openrouter", paths: "/v1/chat/completions" }] }),
    );
    const e = await failure(
      withCloudProviders([["ocra-openrouter/m"]], {}, {}, odd.deps, odd.warn),
    );
    expect(isOcraError(e) && e.code).toBe("CONFIG_INVALID");
    expect(errorMessage(e)).toContain('no OpenAI-compatible chat endpoint for "openrouter"');
  });

  it("takes the effort style ocra Cloud lists, and refuses one it does not know", async () => {
    const styled = (effort: string) => () =>
      Response.json({
        providers: [{ name: "openrouter", paths: ["/v1/chat/completions"], effort }],
      });
    const known = setup({}, {}, styled("openrouter"));
    const out = await withCloudProviders([["ocra-openrouter/m"]], {}, {}, known.deps, known.warn);
    expect(out.providers["ocra-openrouter"]?.effort).toBe("openrouter");

    const unknown = setup({}, {}, styled("anthropic\u001b[31m"));
    const other = await withCloudProviders(
      [["ocra-openrouter/m"]],
      {},
      {},
      unknown.deps,
      unknown.warn,
    );
    expect(other.providers["ocra-openrouter"]).not.toHaveProperty("effort");
    expect(unknown.warnings.join("\n")).toContain(
      'ignoring the effort style ocra Cloud listed for "openrouter"',
    );
    expect(unknown.warnings.join("\n")).not.toContain("anthropic");
  });
});
