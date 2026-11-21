import picomatch from "picomatch";
import type { FileDiff } from "../domain.js";
import type { Learning } from "./learning.js";

export interface SelectionLimits {
  // Learnings given to one task, critical ones included.
  maxSelected: number;
  // Characters of their bodies together; a critical one is given even past it.
  maxChars: number;
  // Critical learnings whose path matches, given whatever the other limits.
  maxCritical: number;
}

export const DEFAULT_SELECTION_LIMITS: SelectionLimits = {
  maxSelected: 5,
  maxChars: 8_000,
  maxCritical: 10,
};

interface LearningSelection {
  selected: Learning[];
  // Candidates the limits left out, best first.
  left: Learning[];
}

interface Indexed {
  learning: Learning;
  matchesPath: (path: string) => boolean;
  symbols: readonly string[];
  keywords: Keyword[];
  terms: string[];
}

interface Match {
  indexed: Indexed;
  path: boolean;
  symbols: number;
  keywords: number;
  terms: number;
}

export type SelectLearnings = (files: readonly FileDiff[]) => LearningSelection;

// The learnings of a run, compiled once and selected from per bundle with
// no model: what a reviewer is shown must not depend on what a model guessed.
export function learningSelector(
  learnings: readonly Learning[],
  limits: SelectionLimits = DEFAULT_SELECTION_LIMITS,
): SelectLearnings {
  const entries = learnings.map(indexed);
  const selections = new WeakMap<readonly FileDiff[], LearningSelection>();
  return (files) => {
    const cached = selections.get(files);
    if (cached) return cached;
    const selection = select(entries, files, limits);
    selections.set(files, selection);
    return selection;
  };
}

function select(
  entries: readonly Indexed[],
  files: readonly FileDiff[],
  limits: SelectionLimits,
): LearningSelection {
  if (entries.length === 0) return { selected: [], left: [] };
  const paths = files.flatMap((f) =>
    f.oldPath === f.newPath ? [f.newPath] : [f.oldPath, f.newPath],
  );
  const text = files.map((f) => f.patch).join("\n");
  const words = wordsOf(text);
  const ranked = entries
    .map((entry) => match(entry, paths, text, words))
    .filter((m) => m.path || m.symbols > 0 || m.keywords > 0)
    .sort(byRank);
  return fill(ranked, limits);
}

function indexed(learning: Learning): Indexed {
  const keywords = learning.keywords.map(keywordOf).filter((k) => k.length > 0);
  return {
    learning,
    matchesPath: picomatch([...learning.paths], { dot: true }),
    symbols: learning.symbols,
    keywords,
    terms: [
      ...new Set([
        ...keywords.flatMap((k) => k.map((t) => t.whole)),
        ...titleTerms(learning.title),
      ]),
    ],
  };
}

function match(
  indexed: Indexed,
  paths: readonly string[],
  text: string,
  words: Set<string>,
): Match {
  return {
    indexed,
    path: paths.some((p) => indexed.matchesPath(p)),
    symbols: indexed.symbols.filter((s) => containsIdentifier(text, s)).length,
    keywords: indexed.keywords.filter((k) => keywordMatches(k, words)).length,
    terms:
      indexed.terms.length === 0
        ? 0
        : indexed.terms.filter((t) => words.has(t)).length / indexed.terms.length,
  };
}

const isCriticalHit = (m: Match) => m.path && m.indexed.learning.critical;

function byRank(a: Match, b: Match): number {
  return (
    Number(isCriticalHit(b)) - Number(isCriticalHit(a)) ||
    Number(b.path) - Number(a.path) ||
    b.symbols - a.symbols ||
    b.keywords - a.keywords ||
    b.terms - a.terms ||
    (a.indexed.learning.id < b.indexed.learning.id ? -1 : 1)
  );
}

function fill(ranked: readonly Match[], limits: SelectionLimits): LearningSelection {
  const selected: Learning[] = [];
  const left: Learning[] = [];
  let chars = 0;
  let critical = 0;
  for (const m of ranked) {
    const { learning } = m.indexed;
    const forced = isCriticalHit(m) && critical < limits.maxCritical;
    const fits =
      selected.length < limits.maxSelected && chars + learning.body.length <= limits.maxChars;
    if (forced || fits) {
      selected.push(learning);
      chars += learning.body.length;
      if (forced) critical++;
    } else {
      left.push(learning);
    }
  }
  return { selected, left };
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

// A plain search with a check at each end, not a regular expression per
// symbol: compiling one with Unicode look-behinds for each of 500 learnings'
// symbols took seconds.
function containsIdentifier(text: string, symbol: string): boolean {
  if (symbol.length === 0) return false;
  const opensWord = isIdentifierChar(codePointAt(symbol, 0));
  const closesWord = isIdentifierChar(codePointBefore(symbol, symbol.length));
  for (let at = text.indexOf(symbol); at !== -1; at = text.indexOf(symbol, at + 1)) {
    const joinedBefore = opensWord && isIdentifierChar(codePointBefore(text, at));
    const joinedAfter = closesWord && isIdentifierChar(codePointAt(text, at + symbol.length));
    if (!joinedBefore && !joinedAfter) return true;
  }
  return false;
}

function isIdentifierChar(char: string): boolean {
  return char !== "" && IDENTIFIER_CHAR.test(char);
}

function codePointAt(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function codePointBefore(text: string, end: number): string {
  return [...text.slice(Math.max(0, end - 2), end)].at(-1) ?? "";
}

const TOKEN = /[\p{L}\p{N}]+/gu;
const WORD_BOUNDARY =
  /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})|(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

// Every token of the text and every part of it split at case changes and
// digits, lowercased, so the keyword "connection pool" matches
// `ConnectionPool` and `connection_pool`.
function wordsOf(text: string): Set<string> {
  const words = new Set<string>();
  for (const token of text.match(TOKEN) ?? []) {
    words.add(token.toLowerCase());
    for (const part of token.split(WORD_BOUNDARY)) words.add(part.toLowerCase());
  }
  return words;
}

// A keyword matches when each of its tokens is in the text, whole or split
// anywhere at its case changes and digits: `OAuthToken` matches
// `oauth_token` as well as `OAuthToken`.
type Keyword = { whole: string; parts: string[] }[];

function keywordOf(phrase: string): Keyword {
  return (phrase.match(TOKEN) ?? []).map((token) => ({
    whole: token.toLowerCase(),
    parts: token.split(WORD_BOUNDARY).map((p) => p.toLowerCase()),
  }));
}

function keywordMatches(keyword: Keyword, words: Set<string>): boolean {
  return keyword.every(({ parts }) => segmentable(parts, words));
}

function segmentable(parts: readonly string[], words: Set<string>): boolean {
  const reachable = [true];
  for (let end = 1; end <= parts.length; end++) {
    reachable[end] = false;
    for (let start = 0; start < end && !reachable[end]; start++) {
      reachable[end] = reachable[start] === true && words.has(parts.slice(start, end).join(""));
    }
  }
  return reachable[parts.length] === true;
}

const STOP_WORDS = new Set([
  "after",
  "always",
  "before",
  "check",
  "every",
  "from",
  "into",
  "must",
  "never",
  "only",
  "should",
  "that",
  "their",
  "them",
  "then",
  "there",
  "this",
  "when",
  "where",
  "which",
  "with",
  "without",
]);

function titleTerms(title: string): string[] {
  return (title.toLowerCase().match(TOKEN) ?? []).filter(
    (w) => w.length >= 4 && !STOP_WORDS.has(w),
  );
}
