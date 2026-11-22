import type { FileDiff } from "../domain.js";
import type { Learning } from "./learning.js";
import { pathMatcher } from "./paths.js";
import {
  type BundleText,
  bundleText,
  type Keyword,
  keywordMatches,
  keywordOf,
  type SymbolPattern,
  symbolMatches,
  symbolOf,
  titleTerms,
} from "./terms.js";

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
  symbols: SymbolPattern[];
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
  const text = bundleText(files.map((f) => f.patch).join("\n"));
  const ranked = entries
    .map((entry) => match(entry, paths, text))
    .filter((m) => m.path || m.symbols > 0 || m.keywords > 0)
    .sort(byRank);
  return fill(ranked, limits);
}

function indexed(learning: Learning): Indexed {
  const keywords = learning.keywords.map(keywordOf).filter((k) => k.length > 0);
  return {
    learning,
    matchesPath: pathMatcher(learning.paths),
    symbols: learning.symbols.map(symbolOf),
    keywords,
    terms: [
      ...new Set([
        ...keywords.flatMap((k) => k.map((t) => t.whole)),
        ...titleTerms(learning.title),
      ]),
    ],
  };
}

function match(indexed: Indexed, paths: readonly string[], text: BundleText): Match {
  return {
    indexed,
    path: paths.some((p) => indexed.matchesPath(p)),
    symbols: indexed.symbols.filter((s) => symbolMatches(s, text)).length,
    keywords: indexed.keywords.filter((k) => keywordMatches(k, text)).length,
    terms:
      indexed.terms.length === 0
        ? 0
        : indexed.terms.filter((t) => text.words.has(t)).length / indexed.terms.length,
  };
}

const isCriticalHit = (m: Match) => m.path && m.indexed.learning.critical;

// A symbol or keyword in the patch is evidence the lesson applies; a path
// alone only says it is about this part of the code. So a path backed by
// evidence ranks first, and a symbol named anywhere outranks a bare path:
// among many lessons on one directory, a bare path must not crowd out the
// one whose symbol the change uses.
function tier(m: Match): number {
  if (isCriticalHit(m)) return 4;
  if (m.path && (m.symbols > 0 || m.keywords > 0)) return 3;
  if (m.symbols > 0) return 2;
  return m.path ? 1 : 0;
}

function byRank(a: Match, b: Match): number {
  return (
    tier(b) - tier(a) ||
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
