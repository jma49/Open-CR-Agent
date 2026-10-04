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
    it(`${json.name} exports its source under @open-cr-agent/source`, () => {
      const entry = json.exports["."];
      expect(Object.keys(entry)[0]).toBe("@open-cr-agent/source");
      expect(existsSync(join(dir, entry["@open-cr-agent/source"]))).toBe(true);
      expect(entry.default).toMatch(/^\.\/dist\//);
    });
  }
});
