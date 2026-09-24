import type { FileDiff, Hunk, LineRange } from "../domain.js";

interface NumberedLine {
  line: number;
  text: string;
  added: boolean;
}

interface Match {
  range: LineRange;
  touchesAdded: boolean;
}

export function matchInHunks(diff: FileDiff, snippet: string): LineRange | undefined {
  const target = normalizeSnippet(snippet);
  if (target.length === 0) return undefined;
  const matches = diff.hunks.flatMap((hunk) => findMatches(newSideLines(hunk), target));
  return preferAdded(matches);
}

export function matchInContent(content: string, snippet: string): LineRange | undefined {
  const target = normalizeSnippet(snippet);
  if (target.length === 0) return undefined;
  const lines = content
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: normalizeLine(text), added: false }));
  return preferAdded(findMatches(lines, target));
}

export function isWithinHunks(diff: FileDiff, range: LineRange): boolean {
  return diff.hunks.some(
    (h) => range.start >= h.newStart && range.end <= h.newStart + h.newLines - 1,
  );
}

function newSideLines(hunk: Hunk): NumberedLine[] {
  return hunk.lines.flatMap((l) =>
    l.kind === "delete"
      ? []
      : [{ line: l.newLine, text: normalizeLine(l.content), added: l.kind === "add" }],
  );
}

// Models often quote only part of a single line, so a one-line snippet may
// also match as a substring once no exact line match exists.
function findMatches(lines: NumberedLine[], target: string[]): Match[] {
  const candidates = lines.filter((l) => l.text !== "");
  const exact = consecutiveMatches(candidates, target, (a, b) => a === b);
  if (exact.length > 0 || target.length > 1) return exact;
  return consecutiveMatches(candidates, target, (line, t) => line.includes(t));
}

function consecutiveMatches(
  lines: NumberedLine[],
  target: string[],
  equals: (line: string, target: string) => boolean,
): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i + target.length <= lines.length; i += 1) {
    const window = lines.slice(i, i + target.length);
    if (window.every((l, j) => equals(l.text, target[j] as string))) {
      matches.push({
        range: {
          start: (window[0] as NumberedLine).line,
          end: (window.at(-1) as NumberedLine).line,
        },
        touchesAdded: window.some((l) => l.added),
      });
    }
  }
  return matches;
}

function preferAdded(matches: Match[]): LineRange | undefined {
  return (matches.find((m) => m.touchesAdded) ?? matches[0])?.range;
}

export function normalizeSnippet(code: string): string[] {
  return code
    .split("\n")
    .map(normalizeLine)
    .filter((l) => l !== "");
}

function normalizeLine(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}
