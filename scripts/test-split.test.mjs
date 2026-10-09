import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// The test files of the unit project (vitest.config.ts).
function unitTests() {
  const dirs = [
    join(root, "scripts"),
    ...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name, "src")),
  ];
  return dirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.test\.(ts|mjs)$/.test(file) && !/\.e2e\.test\./.test(file))
      .map((file) => join(dir, file)),
  );
}

// AGENTS.md: a test that starts a child process (git, biome, bash, node) is a
// *.e2e.test.ts, or *.e2e.test.mjs under scripts/, so `npm run test:unit`
// stays the fast loop.
describe("unit tests", () => {
  it("start no child process", () => {
    const spawning = unitTests()
      .filter((path) =>
        /^import\s[^;]*?\bfrom\s+"node:child_process"/m.test(readFileSync(path, "utf8")),
      )
      .map((path) => relative(root, path));
    expect(spawning).toEqual([]);
  });
});
