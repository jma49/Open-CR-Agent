import { at } from "../at.js";
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

// "ambiguous": the snippet fits several places equally well, so no line is
// picked; a wrong line is worse than a file-level comment.
export type SnippetMatch =
  | { kind: "found"; range: LineRange }
  | { kind: "ambiguous" }
  | { kind: "none" };

// Shortest quote (normalized characters) that may match part of a line. Models
// often quote part of a single line, but a fragment like `err` or `i++`
// occurs on many lines; this is roughly one meaningful expression.
export const MIN_PARTIAL_QUOTE_CHARS = 12;

const NONE: SnippetMatch = { kind: "none" };

export function matchInHunks(diff: FileDiff, snippet: string): SnippetMatch {
  const target = normalizeSnippet(snippet);
  if (target.length === 0) return NONE;
  return pick(findMatches(diff.hunks.map(newSideLines), target));
}

export function matchInContent(content: string, snippet: string): SnippetMatch {
  const target = normalizeSnippet(snippet);
  if (target.length === 0) return NONE;
  const lines = content
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: normalizeLine(text), added: false }));
  return pick(findMatches([lines], target));
}

// Every exact match of the snippet in the hunks of the given files, for
// finding a quote the model attached to the wrong file.
export function exactMatchesInHunks(diffs: readonly FileDiff[], snippet: string) {
  const target = normalizeSnippet(snippet);
  if (target.length === 0) return [];
  return diffs.flatMap((diff) =>
    diff.hunks.flatMap((hunk) =>
      consecutiveMatches(nonBlank(newSideLines(hunk)), target, (a, b) => a === b).map((m) => ({
        file: diff.newPath,
        range: m.range,
      })),
    ),
  );
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

// Whole lines first. A one-line snippet may also match part of a line, but
// only when it is long enough to mean something and fits exactly one line.
// Each group (a hunk, or a whole file) is matched on its own, so a snippet
// never spans two hunks.
function findMatches(groups: NumberedLine[][], target: string[]): Match[] {
  const candidates = groups.map(nonBlank);
  const across = (equals: (line: string, target: string) => boolean) =>
    candidates.flatMap((lines) => consecutiveMatches(lines, target, equals));
  const exact = across((a, b) => a === b);
  if (exact.length > 0 || target.length > 1) return exact;
  const fragment = at(target, 0);
  if (fragment.length < MIN_PARTIAL_QUOTE_CHARS) return [];
  const partial = across((line, t) => line.includes(t));
  return partial.length === 1 ? partial : [];
}

function nonBlank(lines: NumberedLine[]): NumberedLine[] {
  return lines.filter((l) => l.text !== "");
}

function consecutiveMatches(
  lines: NumberedLine[],
  target: string[],
  equals: (line: string, target: string) => boolean,
): Match[] {
  const matches: Match[] = [];
  for (let i = 0; i + target.length <= lines.length; i += 1) {
    const window = lines.slice(i, i + target.length);
    if (window.every((l, j) => equals(l.text, at(target, j)))) {
      matches.push({
        range: {
          start: at(window, 0).line,
          end: (window.at(-1) as NumberedLine).line,
        },
        touchesAdded: window.some((l) => l.added),
      });
    }
  }
  return matches;
}

// Matches touching added lines win; several at the winning level are ambiguous.
function pick(matches: Match[]): SnippetMatch {
  const added = matches.filter((m) => m.touchesAdded);
  const best = added.length > 0 ? added : matches;
  if (best.length === 0) return NONE;
  if (best.length > 1) return { kind: "ambiguous" };
  return { kind: "found", range: at(best, 0).range };
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
