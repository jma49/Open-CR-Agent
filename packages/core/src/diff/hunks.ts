import type { DiffLine, Hunk } from "../domain.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseHunks(lines: readonly string[]): Hunk[] {
  const hunks: Hunk[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i] as string;
    const match = HUNK_HEADER.exec(header);
    i += 1;
    if (!match) continue;

    const hunk: Hunk = {
      header,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
      lines: [],
    };
    i = readHunkBody(lines, i, hunk);
    hunks.push(hunk);
  }
  return hunks;
}

// The body is consumed by the counts in the header rather than by prefixes,
// because a removed line such as "-- comment" would otherwise look like "--- ".
function readHunkBody(lines: readonly string[], start: number, hunk: Hunk): number {
  let oldRemaining = hunk.oldLines;
  let newRemaining = hunk.newLines;
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  let i = start;

  while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const raw = lines[i] as string;
    if (raw.startsWith("\\")) {
      i += 1;
      continue;
    }
    const marker = raw[0] ?? " ";
    const content = raw.slice(1);
    let line: DiffLine;
    if (marker === "+" && newRemaining > 0) {
      line = { kind: "add", content, newLine: newLine++ };
      newRemaining -= 1;
    } else if (marker === "-" && oldRemaining > 0) {
      line = { kind: "delete", content, oldLine: oldLine++ };
      oldRemaining -= 1;
    } else if (marker === " " && oldRemaining > 0 && newRemaining > 0) {
      line = { kind: "context", content, oldLine: oldLine++, newLine: newLine++ };
      oldRemaining -= 1;
      newRemaining -= 1;
    } else {
      break;
    }
    hunk.lines.push(line);
    i += 1;
  }

  while (lines[i]?.startsWith("\\")) i += 1;
  return i;
}
