import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const MAX_LINES = 20;

// The workflows, the composite actions and the Action itself.
function workflowFiles() {
  const workflows = join(".github", "workflows");
  const actions = join(".github", "actions");
  return [
    ...readdirSync(join(root, workflows))
      .filter((name) => name.endsWith(".yml"))
      .map((name) => join(workflows, name)),
    ...readdirSync(join(root, actions)).map((name) => join(actions, name, "action.yml")),
    "action.yml",
  ];
}

/**
 * Each block scalar `run:` in a workflow: its line and its number of non-blank lines.
 * @param {string} text
 */
function runBlocks(text) {
  const lines = text.split("\n");
  return lines.flatMap((line, at) => {
    const run = /^(\s*)(- )?run: *[|>]/.exec(line);
    if (!run) return [];
    const indent = (run[1]?.length ?? 0) + (run[2] ? 2 : 0);
    const body = lines.slice(at + 1);
    const end = body.findIndex((l) => l.trim() !== "" && l.length - l.trimStart().length <= indent);
    const block = body.slice(0, end < 0 ? undefined : end);
    return [{ line: at + 1, lines: block.filter((l) => l.trim() !== "").length }];
  });
}

describe("runBlocks", () => {
  it("counts a block scalar's non-blank lines up to the next key", () => {
    const text =
      "steps:\n  - run: |\n      a\n\n      b\n    env:\n      X: 1\n  - run: one line\n";
    expect(runBlocks(text)).toEqual([{ line: 2, lines: 2 }]);
  });
});

// A longer script goes in a tested file under scripts/ (or next to its
// composite action), where shellcheck and the tests reach it.
describe("inline workflow scripts", () => {
  it(`have at most ${MAX_LINES} lines`, () => {
    const long = workflowFiles().flatMap((file) =>
      runBlocks(readFileSync(join(root, file), "utf8"))
        .filter(({ lines }) => lines > MAX_LINES)
        .map(({ line, lines }) => `${file}:${line} (${lines} lines)`),
    );
    expect(long).toEqual([]);
  });
});
