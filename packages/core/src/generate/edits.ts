import type { FileDiff } from "../domain.js";
import type { DocComment } from "./languages.js";

const MAX_INSERTIONS = 40;
const MAX_DOC_LINES = 40;
const MAX_DOC_LINE_CHARS = 300;

// A doc comment the model asks to insert after line `after` of the file at
// the head (0: before the first line).
export interface Insertion {
  after: number;
  lines: readonly string[];
}

// What a run writes: a new file at a path that has none at the head, or
// lines inserted into a changed file, which stays a subsequence of the result.
export type FileEdit =
  | { kind: "create"; path: string; content: string }
  | {
      kind: "insert";
      path: string;
      original: string;
      insertions: readonly Insertion[];
      content: string;
    };

export interface LineRange {
  from: number;
  to: number;
}

export type Written = { ok: true; edit: FileEdit } | { ok: false; reason: string };

// The new side's lines each hunk covers.
export function changedRanges(diff: FileDiff): LineRange[] {
  return diff.hunks
    .filter((h) => h.newLines > 0)
    .map((h) => ({ from: h.newStart, to: h.newStart + h.newLines - 1 }));
}

// The model's doc comments, inserted only where the change is and only as
// comments: one reply that would do anything else is refused whole.
export function insertDocComments(
  path: string,
  original: string,
  insertions: readonly Insertion[],
  ranges: readonly LineRange[],
  doc: DocComment,
): Written {
  if (insertions.length === 0) return { ok: false, reason: "the model added no doc comment" };
  if (insertions.length > MAX_INSERTIONS) {
    return { ok: false, reason: `the model asked for more than ${MAX_INSERTIONS} insertions` };
  }
  const lines = original.split("\n");
  const count = original.endsWith("\n") ? lines.length - 1 : lines.length;
  const seen = new Set<number>();
  for (const { after, lines: block } of insertions) {
    // A comment documents the line after it, so none goes after the last.
    if (!Number.isInteger(after) || after < 0 || after >= count) {
      return { ok: false, reason: `no line of the file follows line ${after}` };
    }
    if (seen.has(after)) return { ok: false, reason: `two comments after line ${after}` };
    seen.add(after);
    if (!ranges.some((r) => r.from - 1 <= after && after <= r.to)) {
      return { ok: false, reason: `line ${after} is outside the changed lines` };
    }
    // A line continued with a backslash, in a string or an expression, would
    // take the comment into it.
    if (lines[after - 1]?.trimEnd().endsWith("\\")) {
      return { ok: false, reason: `line ${after} continues on the next line` };
    }
    if (block.length > MAX_DOC_LINES || !isDocComment(doc, block)) {
      return { ok: false, reason: `what goes after line ${after} is not a doc comment` };
    }
  }
  const eol = lines.some((l) => l.endsWith("\r")) ? "\r" : "";
  const result = [...lines];
  for (const { after, lines: block } of [...insertions].sort((a, b) => b.after - a.after)) {
    result.splice(after, 0, ...block.map((l) => `${l}${eol}`));
  }
  if (!isSubsequence(lines, result)) {
    return { ok: false, reason: "the result would change an existing line" };
  }
  return {
    ok: true,
    edit: { kind: "insert", path, original, insertions, content: result.join("\n") },
  };
}

export function isSubsequence(original: readonly string[], result: readonly string[]): boolean {
  let next = 0;
  for (const line of result) {
    if (next < original.length && line === original[next]) next += 1;
  }
  return next === original.length;
}

// Checked on the text alone: a block that closes early or holds code after
// its comment is refused, whatever the model meant.
export function isDocComment(doc: DocComment, block: readonly string[]): boolean {
  if (block.length === 0) return false;
  if (block.some((l) => /[\r\n\u2028\u2029]/.test(l) || l.length > MAX_DOC_LINE_CHARS)) {
    return false;
  }
  const trimmed = block.map((l) => l.trim());
  const text = trimmed.join("\n");
  switch (doc.kind) {
    case "line":
      return trimmed.every((l) => l === doc.marker || l.startsWith(`${doc.marker} `));
    case "block":
      return (
        text.startsWith("/**") &&
        !text.startsWith("/**/") &&
        text.indexOf("*/") === text.length - 2 &&
        trimmed.slice(1, -1).every((l) => l.startsWith("*"))
      );
    case "python":
      return (
        text.length >= 6 &&
        text.startsWith('"""') &&
        text.endsWith('"""') &&
        text.split('"""').length === 3 &&
        !text.includes("\\")
      );
  }
}
