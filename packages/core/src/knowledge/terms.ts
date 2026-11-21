const STOP_WORDS = new Set([
  "and",
  "are",
  "async",
  "await",
  "but",
  "can",
  "case",
  "class",
  "const",
  "default",
  "does",
  "else",
  "export",
  "false",
  "for",
  "from",
  "function",
  "has",
  "have",
  "import",
  "into",
  "its",
  "let",
  "new",
  "not",
  "null",
  "one",
  "only",
  "return",
  "should",
  "that",
  "the",
  "then",
  "this",
  "true",
  "type",
  "undefined",
  "use",
  "var",
  "was",
  "when",
  "will",
  "with",
]);

// Lowercased word stems of identifiers and prose: `closePool`, `close_pool`
// and "pools closed" share `close` and `pool`.
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const word of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const part of word.split(/(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u)) {
      const lower = part.toLowerCase();
      if (STOP_WORDS.has(lower) || /^\d+$/.test(lower)) continue;
      const stem = stemOf(lower);
      if (stem.length >= 3 && !STOP_WORDS.has(stem)) out.push(stem);
    }
  }
  return out;
}

// Light suffix stripping, so that "close", "closes", "closed" and "closing"
// meet; a full stemmer would cost a dependency for little more recall.
function stemOf(word: string): string {
  let stem = word;
  if (/^.{3,}i(?:es|ed)$/.test(stem)) stem = `${stem.slice(0, -3)}y`;
  else if (/^.{3,}ing$/.test(stem)) stem = stem.slice(0, -3);
  else if (/^.{3,}ed$/.test(stem)) stem = stem.slice(0, -2);
  else if (/(?:ss|sh|ch|x)es$/.test(stem)) stem = stem.slice(0, -2);
  else if (/^.{2,}[^s]s$/.test(stem)) stem = stem.slice(0, -1);
  return stem.length > 4 && stem.endsWith("e") ? stem.slice(0, -1) : stem;
}
