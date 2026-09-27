import { createHash } from "node:crypto";
import { normalizeSnippet } from "../anchor/match.js";
import type { LineRange, QuoteSignature } from "../domain.js";

// The signature covers the anchored lines of the file, not the model's quote:
// models often quote part of a line, and a partial quote would never match a
// whole line again, so every such finding would look fixed on the next run.
export function quoteSignature(content: string, range: LineRange): QuoteSignature | undefined {
  const lines = normalizeSnippet(
    content
      .split("\n")
      .slice(range.start - 1, range.end)
      .join("\n"),
  );
  if (lines.length === 0) return undefined;
  return { lines: lines.length, hash: hashLines(lines) };
}

// Whether the signed lines still appear, consecutively, in the file. Blank
// lines and whitespace are ignored on both sides.
export function containsQuote(content: string, signature: QuoteSignature): boolean {
  const lines = normalizeSnippet(content);
  for (let i = 0; i + signature.lines <= lines.length; i += 1) {
    if (hashLines(lines.slice(i, i + signature.lines)) === signature.hash) return true;
  }
  return false;
}

function hashLines(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}
