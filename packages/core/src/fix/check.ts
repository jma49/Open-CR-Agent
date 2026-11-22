import { quoteSignature } from "../anchor/quote.js";
import type { SyntaxChecker } from "../contracts.js";
import type { FindingFix } from "../domain.js";
import { isUnsafeCodePoint } from "../unsafe-text.js";
import type { FixCandidate } from "./select.js";

// Fits ocra Cloud's shared finding fields, so an uploaded fix is never cut.
export const MAX_FIX_CHARS = 4_000;
// A fix may grow its lines by this many: a guard or a check, not a rewrite.
export const MAX_ADDED_LINES = 20;

export const FIX_REJECTIONS = [
  "declined",
  "failed",
  "stale",
  "unchanged",
  "unsafe",
  "too_large",
  "no_parser",
  "syntax",
] as const;
export type FixRejection = (typeof FIX_REJECTIONS)[number];

export type FixCheck = { fix: FindingFix } | { rejected: FixRejection };

// A proposed replacement becomes a finding's fix only if it applies to the
// file at the reviewed head exactly where the finding is anchored, changes
// those lines and nothing else, can be committed as written, and leaves the
// file with no more syntax errors than it had.
export async function checkFix(
  finding: FixCandidate,
  content: string,
  proposed: string,
  syntax: SyntaxChecker,
): Promise<FixCheck> {
  const range = finding.lineRange;
  const lines = content.split("\n");
  if (range.end > lines.length || !sameQuote(finding, content)) return { rejected: "stale" };
  const replacement = proposed.endsWith("\n") ? proposed.slice(0, -1) : proposed;
  if (!committable(replacement)) return { rejected: "unsafe" };
  const replaced = lines.slice(range.start - 1, range.end);
  if (replacement === replaced.join("\n")) return { rejected: "unchanged" };
  const added = replacement === "" ? [] : replacement.split("\n");
  if (replacement.length > MAX_FIX_CHARS || added.length > replaced.length + MAX_ADDED_LINES) {
    return { rejected: "too_large" };
  }
  const patched = [...lines.slice(0, range.start - 1), ...added, ...lines.slice(range.end)];
  const [before, after] = await Promise.all([
    syntax.errors(finding.file, content),
    syntax.errors(finding.file, patched.join("\n")),
  ]);
  if (before === undefined || after === undefined) return { rejected: "no_parser" };
  if (after > before) return { rejected: "syntax" };
  return { fix: { startLine: range.start, endLine: range.end, replacement } };
}

function sameQuote(finding: FixCandidate, content: string): boolean {
  const now = quoteSignature(content, finding.lineRange);
  return (
    finding.quote !== undefined &&
    now !== undefined &&
    now.hash === finding.quote.hash &&
    now.lines === finding.quote.lines
  );
}

// Carriage returns and invisible or bidirectional controls are refused, not
// stripped: the replacement is committed exactly as checked.
function committable(replacement: string): boolean {
  for (const char of replacement) {
    if (isUnsafeCodePoint(char.codePointAt(0) as number)) return false;
  }
  return true;
}
