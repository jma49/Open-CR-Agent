import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CloudDeps } from "./cloud.js";
import { capture, critical, deps, removeRepos, repoWithChange } from "./run.fakes.js";
import { run } from "./run.js";

afterEach(removeRepos);

const NOW = Date.now();

function signedIn(env: Record<string, string> = {}) {
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
  const calls: { path: string; body?: unknown }[] = [];
  const cloud: CloudDeps = {
    env,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/api/preferences") {
        return Response.json({
          runtime: null,
          models: { standard: ["ocra-openrouter/m"], light: ["ocra-openrouter/m"] },
          agents: { reviewers: { security: { effort: "high" } } },
        });
      }
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
  return { cloud, calls };
}

describe("a review while signed in to ocra Cloud", () => {
  it("uses the web's default models when none are configured, then sends the counts", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn();
    const err = capture();
    await run(["review"], capture(), err, deps(cwd, critical, { cloud }, true));
    expect(calls.map((c) => c.path)).toEqual([
      "/api/preferences",
      "/api/providers",
      "/api/reviews",
    ]);
    expect(err.text()).toContain(
      "From your ocra Cloud settings: models.standard, models.light, reviewers.security",
    );
    expect(err.text()).toContain("Sent this review's counts to ocra Cloud");
    const sent = calls.at(-1)?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ source: "local", findings: { critical: 1 } });
    expect(JSON.stringify(sent)).not.toMatch(/app\.ts|retries|Negative retry/);
  });

  it("uploads nothing with --no-upload, and keeps configured models", async () => {
    const cwd = repoWithChange();
    const { cloud, calls } = signedIn();
    const d = deps(
      cwd,
      critical,
      { cloud, env: { OCRA_MODEL_STANDARD: "google/x", OCRA_MODEL_LIGHT: "google/x" } },
      true,
    );
    const err = capture();
    await run(["review", "--no-upload"], capture(), err, d);
    // The settings are still read; the repository's models win over the account's.
    expect(calls.map((c) => c.path)).toEqual(["/api/preferences"]);
    expect(err.text()).toContain("From your ocra Cloud settings: reviewers.security");
    expect(err.text()).not.toContain("models.standard");
  });

  it("never contacts ocra Cloud with OCRA_CLOUD=off or without the dependency", async () => {
    const cwd = repoWithChange();
    const off = signedIn({ OCRA_CLOUD: "off" });
    await run(["review"], capture(), capture(), deps(cwd, critical, { cloud: off.cloud }, true));
    expect(off.calls).toEqual([]);
    const err = capture();
    await run(["review"], capture(), err, deps(cwd, critical, {}, true));
    expect(err.text()).not.toContain("ocra Cloud");
  });
});
