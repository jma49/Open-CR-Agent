import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function root(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-remote-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".ocra"));
  writeFileSync(join(dir, ".ocra", "config.json"), JSON.stringify(config));
  return dir;
}

const shared = {
  models: { standard: "google/org-default", top: "google/org-top" },
  include: ["gen/keep/**"],
  reviewers: { performance: { enabled: false } },
  maxCostUsd: 2,
  rules: [{ path: "services/**", rule: "Org rule." }],
};

function serve(body: unknown, seen: string[] = []): typeof fetch {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return (async (url: URL | string) => {
    seen.push(String(url));
    return new Response(text, { status: 200 });
  }) as typeof fetch;
}

describe("extends", () => {
  it("uses the shared configuration as defaults and the repository's values on top", async () => {
    const seen: string[] = [];
    const dir = root({
      extends: "https://config.example.com/ocra.json",
      models: { standard: "google/team" },
      include: ["local/**"],
      reviewers: { security: { minTier: "full" } },
    });
    const config = await loadConfig(dir, {}, { repository: true, fetch: serve(shared, seen) });
    expect(seen).toEqual(["https://config.example.com/ocra.json"]);
    expect(config.models).toEqual({ standard: ["google/team"], top: ["google/org-top"] });
    expect(config.include).toEqual(["gen/keep/**", "local/**"]);
    expect(config.reviewers).toEqual({
      performance: { enabled: false },
      security: { minTier: "full" },
    });
    expect(config.maxCostUsd).toBe(2);
    expect(config.rules).toEqual([{ path: "services/**", rule: "Org rule." }]);
  });

  it("checks a pinned hash, and falls back to the repository's own file with a warning", async () => {
    const body = JSON.stringify(shared);
    const hash = createHash("sha256").update(body).digest("hex");
    const pinned = await loadConfig(
      root({ extends: `https://c.example/o.json#sha256=${hash}` }),
      {},
      {
        repository: true,
        fetch: serve(body),
      },
    );
    expect(pinned.maxCostUsd).toBe(2);

    for (const [spec, served, message] of [
      [
        `https://c.example/o.json#sha256=${"0".repeat(64)}`,
        body,
        "does not match its pinned sha256",
      ],
      ["http://c.example/o.json", body, "must be an https URL"],
      ["https://c.example/o.json", { plugins: ["./evil.mjs"] }, "is invalid"],
    ] as const) {
      const warnings: string[] = [];
      const config = await loadConfig(
        root({ extends: spec, concurrency: 3 }),
        {},
        {
          repository: true,
          fetch: serve(served),
          warn: (m) => warnings.push(m),
        },
      );
      expect(warnings[0]).toContain(message);
      expect(config.concurrency).toBe(3);
      expect(config.rules).toEqual([]);
    }
  });
});
