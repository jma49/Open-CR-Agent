import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CloudDeps } from "../../cloud/deps.js";
import { sharingConsentPath } from "../../cloud/sharing-consent.js";

// A signed-in machine against a fake ocra Cloud, for the CLI's end-to-end
// tests of what a review takes from and sends to it. It signed in while the
// account shared findings, so it agreed to send them when the account
// answers a salt.

const NOW = Date.now();

export const PREFERENCES = {
  runtime: null,
  models: { standard: ["ocra-openrouter/m"], light: ["ocra-openrouter/m"] },
  agents: { reviewers: { security: { effort: "high" } } },
};

export function signedIn(
  env: Record<string, string> = {},
  preferences: unknown = PREFERENCES,
  offline = false,
  // Answers that replace the defaults, by path.
  routes: Record<string, (url: URL, body: unknown) => Response> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "ocra-runcloud-"));
  const credentialsPath = join(dir, "ocra", "credentials.json");
  mkdirSync(join(dir, "ocra"));
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      server: "https://cloud.test",
      login: "octo",
      access_token: "ocra_cli_t",
      refresh_token: "ocra_ref_r",
      expires_at: NOW + 3_600_000,
    }),
  );
  writeFileSync(sharingConsentPath(credentialsPath), "on\n");
  const calls: { path: string; query: string; body?: unknown }[] = [];
  const cloud: CloudDeps = {
    env,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, query: url.search, ...(body ? { body } : {}) });
      if (offline) throw new TypeError("fetch failed");
      const route = routes[path];
      if (route) return route(url, body);
      if (path === "/api/preferences") return Response.json(preferences);
      if (path === "/api/providers")
        return Response.json({
          providers: [{ name: "openrouter", paths: ["/v1/chat/completions"] }],
        });
      if (path === "/api/reviews") return Response.json({ id: "r1" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    now: Date.now,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
  return { cloud, calls, credentialsPath };
}
