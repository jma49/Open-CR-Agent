import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { capture, critical, deps, removeRepos, repoWithChange } from "./run.fakes.js";
import { run } from "./run.js";
import { PREFERENCES, signedIn } from "./run-cloud.fakes.js";

// What a review does when its ocra Cloud session cannot be used.

afterEach(removeRepos);

const OWN_MODELS = { OCRA_MODEL_STANDARD: "google/x", OCRA_MODEL_LIGHT: "google/x" };
const CLOUD_MODELS = { OCRA_MODEL_STANDARD: "ocra-openrouter/m", OCRA_MODEL_LIGHT: "google/x" };
const LOST =
  "this review runs without your account's rules, limits (maxCostUsd included), models and memory, and uploads nothing";

/** A signed-in machine whose access token is due, and the refresh's answer. */
function due(refresh: () => Response, preferences: unknown = PREFERENCES) {
  const machine = signedIn({}, preferences, false, { "/api/device/refresh": refresh });
  const saved = JSON.parse(readFileSync(machine.credentialsPath, "utf8"));
  writeFileSync(machine.credentialsPath, JSON.stringify({ ...saved, expires_at: Date.now() - 1 }));
  return machine;
}

async function review(machine: ReturnType<typeof signedIn>, env: Record<string, string>) {
  const err = capture();
  const exit = await run(
    ["review"],
    capture(),
    err,
    deps(repoWithChange(), critical, { cloud: machine.cloud, env }, true),
  );
  return { exit, err: err.text(), paths: machine.calls.map((c) => c.path) };
}

const revoked = () => Response.json({ error: "invalid_grant" }, { status: 400 });
const down = () => new Response("{}", { status: 503 });

describe("a review whose ocra Cloud session cannot be used", () => {
  it("revoked: warns once to run ocra login, and leaves ocra Cloud alone", async () => {
    const r = await review(due(revoked), OWN_MODELS);
    expect(r.exit).toBe(1);
    expect(r.err.match(/\[ocra\] Warning: .*\n/g)).toEqual([
      `[ocra] Warning: your ocra Cloud session ended: run ocra login; ${LOST}\n`,
    ]);
    expect(r.paths).toEqual(["/api/device/refresh"]);
  });

  it("unreachable: warns once, naming what the run loses, and goes on", async () => {
    const r = await review(due(down), OWN_MODELS);
    expect(r.exit).toBe(1);
    expect(r.err.match(/\[ocra\] Warning: .*\n/g)).toEqual([
      `[ocra] Warning: could not reach ocra Cloud (HTTP 503); ${LOST}\n`,
    ]);
    expect(r.paths).toEqual(["/api/device/refresh"]);
  });

  it("with an ocra- model, unreachable is an error that says so, not a sign-in hint", async () => {
    const r = await review(due(down), CLOUD_MODELS);
    expect(r.exit).toBe(2);
    expect(r.err).toContain(
      "Models name ocra Cloud (ocra-openrouter) but ocra Cloud could not be reached (HTTP 503)",
    );
    expect(r.err).not.toContain("sign in");
  });

  it("with an ocra- model, revoked says the session ended", async () => {
    const r = await review(due(revoked), CLOUD_MODELS);
    expect(r.exit).toBe(2);
    expect(r.err).toContain(
      "Models name ocra Cloud (ocra-openrouter): your ocra Cloud session ended: run ocra login",
    );
  });
});

describe("a server without account settings", () => {
  it("answers 404 for the preferences: no settings and no warning", async () => {
    const machine = signedIn({}, PREFERENCES, false, {
      "/api/preferences": () => new Response("{}", { status: 404 }),
    });
    const r = await review(machine, OWN_MODELS);
    expect(r.err).not.toContain("Warning");
    expect(r.err).not.toContain("From your ocra Cloud settings");
    expect(r.paths).toContain("/api/reviews");
  });

  it("a 401 for a live token is refreshed once and the settings read again", async () => {
    let first = true;
    const machine = signedIn({}, PREFERENCES, false, {
      "/api/preferences": () => {
        const answer = first ? new Response("{}", { status: 401 }) : Response.json(PREFERENCES);
        first = false;
        return answer;
      },
      "/api/device/refresh": () =>
        Response.json({
          access_token: "ocra_cli_2",
          refresh_token: "ocra_ref_2",
          expires_in: 3600,
        }),
    });
    const r = await review(machine, OWN_MODELS);
    expect(r.err).not.toContain("Warning");
    expect(r.err).toContain("From your ocra Cloud settings: reviewers.security");
    expect(r.paths.slice(0, 3)).toEqual([
      "/api/preferences",
      "/api/device/refresh",
      "/api/preferences",
    ]);
  });
});
