import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const MAX_LINES = 500;

// AGENTS.md: no source file may exceed 500 lines, tests included. A file
// near the limit is a module boundary to redraw, not a test to relax.
describe("source files", () => {
  it(`have at most ${MAX_LINES} lines`, () => {
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.mjs", "*.js"],
      { cwd: root, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    const over = files
      .map((file) => ({ file, lines: lineCount(join(root, file)) }))
      .filter(({ lines }) => lines > MAX_LINES);
    expect(over).toEqual([]);
  });
});

function lineCount(path) {
  const text = readFileSync(path, "utf8");
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
