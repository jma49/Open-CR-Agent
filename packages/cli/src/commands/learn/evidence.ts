import type { FileDiff } from "@open-cr-agent/core";

// A file as the unchanged lines of a diff: what a source shows the drafter
// when its evidence is a file rather than a change, so the draft's symbols
// are checked against it and the selection replays it like a change there.
export function unchanged(path: string, content: string, max: number): FileDiff {
  const patch = content
    .slice(0, max)
    .split("\n")
    .map((line) => ` ${line}`)
    .join("\n");
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    patch,
  };
}
