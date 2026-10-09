import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// The scripts and the packages' sources, tests left out.
function sources() {
  const dirs = [
    join(root, "scripts"),
    ...readdirSync(join(root, "packages")).map((name) => join(root, "packages", name, "src")),
  ];
  return dirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|mjs)$/.test(file) && !/\.(test|fakes)\.|node_modules/.test(file))
      .map((file) => join(dir, file)),
  );
}

// A shell option other than false, and exec and execSync, which always start a shell.
const SHELL = [
  /\bshell:(?!\s*false\b)/,
  /\bexecSync\(/,
  /\{[^}]*\bexec\b[^}]*\} from "node:child_process"/,
];

// AGENTS.md: child processes start with an argument array, never a shell,
// which would read quoting and metacharacters (&, ^, |) in an argument.
describe("child processes", () => {
  it("never start through a shell", () => {
    const shells = sources().flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          SHELL.some((pattern) => pattern.test(line)) ? [`${relative(root, path)}:${i + 1}`] : [],
        ),
    );
    expect(shells).toEqual([]);
  });
});
