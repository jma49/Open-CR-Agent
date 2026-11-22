import type { ContextSource } from "../review/context-sources.js";
import type { PromptPart } from "../review/prompt.js";

export interface SourceFootprint {
  source: ContextSource;
  // Four characters per token, like the rest of the plan.
  tokens: number;
  // Texts held to a limit and lists cut short in this part.
  cut?: number;
  // Tokens of lines an earlier part of the same prompt already holds.
  duplicateTokens?: number;
}

const CUT_MARKERS = /\[truncated\]|^and \d+ more\b/gm;
// Shorter lines (braces, blank lines, imports) repeat in any code.
const MIN_DUPLICATE_LINE_CHARS = 40;

// What each source adds to one prompt (ADR-0057). A source that is in no
// part is absent, not zero.
export function contextFootprint(parts: readonly PromptPart[]): SourceFootprint[] {
  const seen = new Set<string>();
  const bySource = new Map<ContextSource, SourceFootprint>();
  for (const { source, text } of parts) {
    const entry = bySource.get(source) ?? { source, tokens: 0 };
    entry.tokens += estimateTokens(text);
    const cut = text.match(CUT_MARKERS)?.length ?? 0;
    if (cut > 0) entry.cut = (entry.cut ?? 0) + cut;
    let duplicateChars = 0;
    const own = new Set<string>();
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (line.length < MIN_DUPLICATE_LINE_CHARS) continue;
      if (seen.has(line)) duplicateChars += line.length;
      own.add(line);
    }
    for (const line of own) seen.add(line);
    if (duplicateChars > 0) {
      entry.duplicateTokens = (entry.duplicateTokens ?? 0) + estimateTokens(duplicateChars);
    }
    bySource.set(source, entry);
  }
  return [...bySource.values()];
}

export function estimateTokens(text: string | number): number {
  return Math.ceil((typeof text === "number" ? text : text.length) / 4);
}
