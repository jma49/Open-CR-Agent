import picomatch from "picomatch";
import type { Learning } from "./learning.js";
import { terms } from "./terms.js";

// What one review task changes: its files' old and new paths, and their patches.
export interface ChangeScope {
  paths: readonly string[];
  text: string;
}

export interface LearningPolicy {
  // Learnings shown in full, critical ones included.
  maxEntries: number;
  // Their bodies' total size; critical ones may exceed it, with a warning.
  maxChars: number;
  // Further matches listed by id and title only.
  maxIndexed: number;
  // The share of its title and keyword terms a learning without paths needs
  // to find in the change to match on text alone, with at least two terms.
  minTextCoverage: number;
}

export const defaultLearningPolicy: LearningPolicy = {
  maxEntries: 5,
  maxChars: 6_000,
  maxIndexed: 20,
  minTextCoverage: 1 / 3,
};

type MatchReason = "path" | "symbol" | "keyword" | "text";

interface MatchedLearning {
  learning: Learning;
  reasons: MatchReason[];
  score: number;
}

export interface LearningSelection {
  included: MatchedLearning[];
  indexed: MatchedLearning[];
  // Matches beyond maxIndexed.
  omitted: number;
  warnings: string[];
}

// How much a learning's history should count, from the product's stats: a
// learning that keeps catching real issues ranks above one that is ignored.
export type LearningWeights = ReadonlyMap<string, number>;

interface IndexedLearning {
  learning: Learning;
  inPaths?: (path: string) => boolean;
  symbols: readonly string[];
  keywords: KeywordMatcher[];
  // Terms of the title and keywords, which a learning without paths must
  // share with the change to match on text alone.
  keyTerms: ReadonlySet<string>;
  termCounts: ReadonlyMap<string, number>;
  length: number;
}

type KeywordMatcher = { terms: string[] } | { literal: string };

interface ChangeTerms {
  terms: ReadonlySet<string>;
  lowerText: string;
}

// Built once per run: matchers and term statistics are compiled here, not
// for every review task.
export interface LearningIndex {
  entries: readonly IndexedLearning[];
  documentFrequency: ReadonlyMap<string, number>;
  averageLength: number;
}

export function indexLearnings(learnings: readonly Learning[]): LearningIndex {
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;
  const entries = [...learnings].sort(byId).map((learning): IndexedLearning => {
    const keywordTerms = (learning.keywords ?? []).flatMap(terms);
    const titleTerms = terms(learning.title);
    // The title and keywords count twice: they are written to be matched.
    const words = [...titleTerms, ...titleTerms, ...keywordTerms, ...keywordTerms];
    words.push(...terms(learning.body));
    const termCounts = new Map<string, number>();
    for (const w of words) termCounts.set(w, (termCounts.get(w) ?? 0) + 1);
    for (const w of termCounts.keys()) {
      documentFrequency.set(w, (documentFrequency.get(w) ?? 0) + 1);
    }
    totalLength += words.length;
    return {
      learning,
      ...(learning.paths ? { inPaths: picomatch([...learning.paths], { dot: true }) } : {}),
      symbols: learning.symbols ?? [],
      keywords: (learning.keywords ?? []).map(keywordMatcher),
      keyTerms: new Set([...titleTerms, ...keywordTerms]),
      termCounts,
      length: words.length,
    };
  });
  return {
    entries,
    documentFrequency,
    averageLength: entries.length === 0 ? 0 : totalLength / entries.length,
  };
}

const REASON_SCORE = { path: 2, keyword: 2, symbol: 4 } as const;
const MIN_TEXT_TERMS = 2;
const MIN_WEIGHT = 0.25;
const MAX_WEIGHT = 4;

// Deterministic: the same learnings and change select the same entries in the
// same order, whatever order the learnings came in. Recall comes first, so a
// match is never dropped silently: what does not fit in full is indexed, and
// what does not fit in the index is counted.
export function selectLearnings(
  index: LearningIndex,
  change: ChangeScope,
  policy: LearningPolicy = defaultLearningPolicy,
  weights: LearningWeights = new Map(),
): LearningSelection {
  const changeTerms = new Set(terms(`${change.paths.join(" ")}\n${change.text}`));
  const scope: ChangeTerms = { terms: changeTerms, lowerText: change.text.toLowerCase() };
  const full: MatchedLearning[] = [];
  const indexOnly: MatchedLearning[] = [];
  for (const entry of index.entries) {
    const inPath = entry.inPaths !== undefined && change.paths.some(entry.inPaths);
    const reasons: MatchReason[] = [];
    if (inPath) reasons.push("path");
    if (entry.symbols.some((s) => containsWhole(change.text, s))) reasons.push("symbol");
    if (entry.keywords.some((k) => keywordFound(k, scope))) {
      reasons.push("keyword");
    }
    const inScope = inPath || entry.inPaths === undefined;
    if (entry.inPaths === undefined && coversKeyTerms(entry, changeTerms, policy)) {
      reasons.push("text");
    }
    if (reasons.length === 0) continue;
    const evidence = reasons.reduce((sum, r) => sum + (r === "text" ? 0 : REASON_SCORE[r]), 0);
    const text = inScope ? bm25(index, entry, changeTerms) : 0;
    const matched = {
      learning: entry.learning,
      reasons,
      score: (evidence + text) * weightOf(weights, entry.learning.id),
    };
    // Outside its paths, only a symbol the learning names is evidence enough
    // to show it in full; a shared word is not.
    (inScope || reasons.includes("symbol") ? full : indexOnly).push(matched);
  }
  return fit(full.sort(byRank), indexOnly.sort(byRank), policy);
}

function fit(
  candidates: readonly MatchedLearning[],
  indexOnly: readonly MatchedLearning[],
  policy: LearningPolicy,
): LearningSelection {
  const included: MatchedLearning[] = [];
  const rest: MatchedLearning[] = [];
  let chars = 0;
  for (const m of candidates) {
    const size = m.learning.body.length;
    const fits = included.length < policy.maxEntries && chars + size <= policy.maxChars;
    if (isForced(m) || fits) {
      included.push(m);
      chars += size;
    } else rest.push(m);
  }
  rest.push(...indexOnly);
  const warnings: string[] = [];
  const forced = included.filter(isForced).length;
  if (forced > policy.maxEntries || chars > policy.maxChars) {
    warnings.push(
      `${forced} critical learnings match this change and are all shown, above the limit of ${policy.maxEntries} learnings or ${policy.maxChars} characters`,
    );
  }
  return {
    included,
    indexed: rest.slice(0, policy.maxIndexed),
    omitted: Math.max(0, rest.length - policy.maxIndexed),
    warnings,
  };
}

function isForced(m: MatchedLearning): boolean {
  return m.learning.critical && m.reasons.includes("path");
}

function byRank(a: MatchedLearning, b: MatchedLearning): number {
  return (
    Number(isForced(b)) - Number(isForced(a)) || b.score - a.score || byId(a.learning, b.learning)
  );
}

function byId(a: Learning, b: Learning): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const IDENTIFIER_CHAR = /[\p{L}\p{N}_$]/u;

// A plain search with a boundary check: a Unicode regular expression per
// symbol costs more to compile and run than the rest of the selection.
function containsWhole(text: string, needle: string): boolean {
  if (needle.length === 0) return false;
  const wordStart = isIdentifierChar(firstCodePoint(needle, 0));
  const wordEnd = isIdentifierChar(lastCodePoint(needle, needle.length));
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    const joinedBefore = wordStart && isIdentifierChar(lastCodePoint(text, at));
    const joinedAfter = wordEnd && isIdentifierChar(firstCodePoint(text, at + needle.length));
    if (!joinedBefore && !joinedAfter) return true;
  }
  return false;
}

function isIdentifierChar(char: string): boolean {
  return char !== "" && IDENTIFIER_CHAR.test(char);
}

function firstCodePoint(text: string, at: number): string {
  const code = text.codePointAt(at);
  return code === undefined ? "" : String.fromCodePoint(code);
}

function lastCodePoint(text: string, end: number): string {
  return [...text.slice(Math.max(0, end - 2), end)].at(-1) ?? "";
}

// A keyword of stop words only ("uses") is looked for as written.
function keywordMatcher(keyword: string): KeywordMatcher {
  const wanted = terms(keyword);
  return wanted.length > 0 ? { terms: wanted } : { literal: keyword.toLowerCase() };
}

function keywordFound(k: KeywordMatcher, change: ChangeTerms): boolean {
  return "terms" in k
    ? k.terms.every((t) => change.terms.has(t))
    : containsWhole(change.lowerText, k.literal);
}

function coversKeyTerms(
  entry: IndexedLearning,
  changeTerms: ReadonlySet<string>,
  policy: LearningPolicy,
): boolean {
  let found = 0;
  for (const t of entry.keyTerms) if (changeTerms.has(t)) found++;
  return found >= MIN_TEXT_TERMS && found >= entry.keyTerms.size * policy.minTextCoverage;
}

function weightOf(weights: LearningWeights, id: string): number {
  const weight = weights.get(id);
  if (weight === undefined || !Number.isFinite(weight)) return 1;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, weight));
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

// The learnings are the corpus and the change's distinct terms the query.
function bm25(index: LearningIndex, entry: IndexedLearning, changeTerms: ReadonlySet<string>) {
  if (index.averageLength === 0) return 0;
  const n = index.entries.length;
  const norm = BM25_K1 * (1 - BM25_B + (BM25_B * entry.length) / index.averageLength);
  let score = 0;
  for (const [term, count] of entry.termCounts) {
    if (!changeTerms.has(term)) continue;
    const df = index.documentFrequency.get(term) ?? 0;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    score += (idf * (count * (BM25_K1 + 1))) / (count + norm);
  }
  return score;
}
