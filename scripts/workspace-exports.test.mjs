import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWorkspaces } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Tests resolve workspace packages to their source through this condition
// (vitest.config.ts, tsconfig.test.json), so they need no build. It comes
// first, or the dist/ entries would win; consumers never set it.
describe("workspace exports", () => {
  for (const { dir, json } of readWorkspaces(root)) {
    const entries = Object.entries(json.exports ?? {}).filter(
      /** @returns {pair is [string, Record<string, string>]} */
      (pair) => typeof pair[1] === "object",
    );

    // A private package (eval) is a command, not a library: it has no API.
    if (!json.private) {
      it(`${json.name} has a main entry`, () => {
        expect(json.exports?.["."]).toBeTypeOf("object");
      });
    }

    for (const [path, entry] of entries) {
      it(`${json.name} exports the source of ${path} under @open-cr-agent/source`, () => {
        expect(Object.keys(entry)[0]).toBe("@open-cr-agent/source");
        expect(existsSync(join(dir, String(entry["@open-cr-agent/source"])))).toBe(true);
        expect(entry.types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
        expect(entry.default).toMatch(/^\.\/dist\//);
      });
    }
  }
});

// A runtime is a plugin like a third party's (ADR-0006): it builds on core's
// public API only, so that API is enough to write one.
describe("runtime packages", () => {
  for (const { dir, json } of readWorkspaces(root).filter((w) =>
    w.json.name.includes("/runtime-"),
  )) {
    it(`${json.name} imports nothing from @open-cr-agent/core/internal`, () => {
      const src = join(dir, "src");
      const files = readdirSync(src, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
      expect(files.length).toBeGreaterThan(0);
      const internal = files.filter((f) =>
        readFileSync(join(src, String(f)), "utf8").includes('"@open-cr-agent/core/internal"'),
      );
      expect(internal).toEqual([]);
    });
  }
});
