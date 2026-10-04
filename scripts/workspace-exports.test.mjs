import { existsSync } from "node:fs";
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
    const entries = Object.entries(json.exports).filter(([, entry]) => typeof entry === "object");

    it(`${json.name} has a main entry`, () => {
      expect(json.exports["."]).toBeTypeOf("object");
    });

    for (const [path, entry] of entries) {
      it(`${json.name} exports the source of ${path} under @open-cr-agent/source`, () => {
        expect(Object.keys(entry)[0]).toBe("@open-cr-agent/source");
        expect(existsSync(join(dir, entry["@open-cr-agent/source"]))).toBe(true);
        expect(entry.types).toMatch(/^\.\/dist\/.*\.d\.ts$/);
        expect(entry.default).toMatch(/^\.\/dist\//);
      });
    }
  }
});
