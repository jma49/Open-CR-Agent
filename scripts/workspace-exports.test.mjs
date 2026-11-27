import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readWorkspaces } from "./lib/release.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const workspaces = readWorkspaces(root);

// Tests resolve workspace packages to their source through this condition
// (vitest.config.ts, tsconfig.test.json), so they need no build. It comes
// first, or the dist/ entries would win; consumers never set it.
describe("workspace exports", () => {
  for (const { dir, json } of workspaces) {
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

// The CLI composes the adapters; the adapters never compose each other.
// This is a limit on installed dependencies, not on shared test fixtures.
describe("core and adapter package boundaries", () => {
  const names = new Set(workspaces.map(({ json }) => json.name));
  const core = "@open-cr-agent/core";
  const platform = "@open-cr-agent/vcs-platform";
  for (const { json } of workspaces) {
    const name = json.name;
    if (name !== core && !/^@open-cr-agent\/(runtime-|vcs-|code-graph$)/.test(name)) continue;
    it(`${name} keeps its installed workspace dependencies below it`, () => {
      const allowed = new Set(name === core ? [] : [core]);
      if (name === "@open-cr-agent/vcs-github" || name === "@open-cr-agent/vcs-gitlab") {
        allowed.add(platform);
      }
      const installed = {
        ...json.dependencies,
        ...json.optionalDependencies,
        ...json.peerDependencies,
      };
      expect(Object.keys(installed).filter((dep) => names.has(dep) && !allowed.has(dep))).toEqual(
        [],
      );
    });
  }
});

// A runtime is a plugin like a third party's (ADR-0006): it builds on core's
// public API only, so that API is enough to write one.
describe("runtime packages", () => {
  for (const { dir, json } of workspaces.filter((w) => w.json.name.includes("/runtime-"))) {
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
