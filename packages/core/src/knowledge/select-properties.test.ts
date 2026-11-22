import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FileDiff } from "../domain.js";
import type { Learning } from "./learning.js";
import { pathMatcher } from "./paths.js";
import { DEFAULT_SELECTION_LIMITS, learningSelector, type SelectionLimits } from "./select.js";
import { bundleText, keywordMatches, keywordOf, symbolMatches, symbolOf } from "./terms.js";

const GLOBS = ["src/a/**", "src/b/**", "src/*/db/**", "*.sql", "docs/", "lib/*.ts", "/README.md"];
const FILES = ["src/a/x.ts", "src/b/db/q.sql", "src/c/db/pool.ts", "docs/guide.md", "lib/util.ts"];
const SYMBOLS = ["pool.connect", "createCharge", "timingSafeEqual", "t(", "USER"];
const WORDS = ["retry", "token", "cache", "connection leak", "重复消费", "tenant"];
const CODE = [
  "pool.connect()",
  "create_charge(x)",
  "timingSafeEqual(a, b)",
  "t('key')",
  "USER node",
  "three retries",
  "tokens",
  "// 避免重复消费",
  "tenant_id",
  "noise",
];

const unbounded: SelectionLimits = {
  maxSelected: Number.MAX_SAFE_INTEGER,
  maxChars: Number.MAX_SAFE_INTEGER,
  maxCritical: Number.MAX_SAFE_INTEGER,
};

const learningAt = (id: string) =>
  fc.record({
    id: fc.constant(id),
    title: fc.constantFrom("Release clients", "Cache per tenant", "Retry with jitter"),
    body: fc.string({ maxLength: 3_000 }),
    paths: fc.uniqueArray(fc.constantFrom(...GLOBS), { minLength: 1, maxLength: 3 }),
    symbols: fc.uniqueArray(fc.constantFrom(...SYMBOLS), { maxLength: 2 }),
    keywords: fc.uniqueArray(fc.constantFrom(...WORDS), { maxLength: 2 }),
    critical: fc.boolean(),
  }) satisfies fc.Arbitrary<Learning>;

const learnings = fc
  .integer({ min: 0, max: 30 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => learningAt(`l${i}`))));

const fileDiff = fc
  .record({
    path: fc.constantFrom(...FILES),
    renamedFrom: fc.option(fc.constantFrom(...FILES), { nil: undefined }),
    lines: fc.array(fc.constantFrom(...CODE), { maxLength: 4 }),
  })
  .map(
    ({ path, renamedFrom, lines }): FileDiff => ({
      oldPath: renamedFrom ?? path,
      newPath: path,
      kind: renamedFrom ? "renamed" : "modified",
      isBinary: false,
      additions: lines.length,
      deletions: 0,
      hunks: [],
      patch: lines.map((l) => `+${l}`).join("\n"),
    }),
  );

const bundle = fc.array(fileDiff, { minLength: 1, maxLength: 4 });

const ids = (ls: readonly Learning[]) => ls.map((l) => l.id);
const pathsOf = (files: readonly FileDiff[]) => files.flatMap((f) => [f.oldPath, f.newPath]);
const pathHit = (l: Learning, files: readonly FileDiff[]) =>
  pathsOf(files).some(pathMatcher(l.paths));

// A learning is a candidate when it is selected on its own, with no limits.
const candidates = (ls: readonly Learning[], files: FileDiff[]) =>
  new Set(
    ls
      .filter((l) => learningSelector([l], unbounded)(files).selected.length === 1)
      .map((l) => l.id),
  );

describe("learning selection, for any learnings and bundle", () => {
  it("depends neither on the order of the learnings nor on a second call", () => {
    const reordered = learnings.chain((ls) =>
      fc.tuple(fc.constant(ls), fc.shuffledSubarray(ls, { minLength: ls.length })),
    );
    fc.assert(
      fc.property(reordered, bundle, ([ls, shuffled], files) => {
        const select = learningSelector(ls);
        const first = select(files);
        const second = learningSelector(shuffled)(files);
        expect(ids(second.selected)).toEqual(ids(first.selected));
        expect(ids(second.left)).toEqual(ids(first.left));
        expect(select([...files])).toEqual(first);
      }),
    );
  });

  it("gives or leaves every candidate exactly once, and nothing else", () => {
    fc.assert(
      fc.property(learnings, bundle, (ls, files) => {
        const { selected, left } = learningSelector(ls)(files);
        const all = [...ids(selected), ...ids(left)];
        expect(new Set(all).size).toBe(all.length);
        expect(new Set(all)).toEqual(candidates(ls, files));
      }),
    );
  });

  it("keeps to the limits, and gives every critical learning on a matching path", () => {
    fc.assert(
      fc.property(learnings, bundle, (ls, files) => {
        const { maxSelected, maxChars, maxCritical } = DEFAULT_SELECTION_LIMITS;
        const { selected, left } = learningSelector(ls)(files);
        const forced = selected
          .filter((l) => l.critical && pathHit(l, files))
          .slice(0, maxCritical);
        const rest = selected.filter((l) => !forced.includes(l));
        expect(selected.length).toBeLessThanOrEqual(Math.max(maxSelected, forced.length));
        expect(rest.reduce((sum, l) => sum + l.body.length, 0)).toBeLessThanOrEqual(maxChars);
        const leftCritical = left.filter((l) => l.critical && pathHit(l, files));
        if (leftCritical.length > 0) expect(forced).toHaveLength(maxCritical);
      }),
    );
  });

  it("leaves nothing out when nothing limits it", () => {
    fc.assert(
      fc.property(learnings, bundle, (ls, files) => {
        expect(learningSelector(ls, unbounded)(files).left).toEqual([]);
      }),
    );
  });

  it("is not changed by learnings that match nothing", () => {
    fc.assert(
      fc.property(learnings, bundle, fc.integer({ min: 1, max: 50 }), (ls, files, n) => {
        const noise = Array.from({ length: n }, (_, i) => ({
          id: `z${i}`,
          title: "Unrelated",
          body: "",
          paths: [`elsewhere/${i}/**`],
          symbols: [`unrelatedHelper${i}`],
          keywords: [`unrelated topic ${i}`],
          critical: i % 2 === 0,
        }));
        const without = learningSelector(ls)(files);
        const withNoise = learningSelector([...noise, ...ls])(files);
        expect(ids(withNoise.selected)).toEqual(ids(without.selected));
        expect(ids(withNoise.left)).toEqual(ids(without.left));
      }),
    );
  });

  it("finds at least the candidates of each file in a bundle of several", () => {
    fc.assert(
      fc.property(learnings, bundle, bundle, (ls, a, b) => {
        const both = candidates(ls, [...a, ...b]);
        for (const id of candidates(ls, a)) expect(both).toContain(id);
      }),
    );
  });

  it("keeps the learnings of a renamed file's old path", () => {
    fc.assert(
      fc.property(
        learnings,
        fc.constantFrom(...FILES),
        fc.constantFrom(...FILES),
        (ls, from, to) => {
          const renamed: FileDiff = {
            oldPath: from,
            newPath: to,
            kind: "renamed",
            isBinary: false,
            additions: 0,
            deletions: 0,
            hunks: [],
            patch: "",
          };
          const found = candidates(ls, [renamed]);
          for (const l of ls) if (pathMatcher(l.paths)(from)) expect(found).toContain(l.id);
        },
      ),
    );
  });
});

const word = fc.stringMatching(/^[a-z]{2,8}$/);

describe("names and words, in any spelling", () => {
  it("finds a name of several words in any naming convention", () => {
    const spellings = (words: string[]) => {
      const cap = (w: string) => w[0]?.toUpperCase() + w.slice(1);
      return [
        words[0] + words.slice(1).map(cap).join(""),
        words.map(cap).join(""),
        words.join("_"),
        words.join("_").toUpperCase(),
      ];
    };
    fc.assert(
      fc.property(fc.array(word, { minLength: 2, maxLength: 4 }), (words) => {
        for (const symbol of spellings(words)) {
          for (const used of spellings(words)) {
            expect(
              symbolMatches(symbolOf(symbol), bundleText(`+ ${used}(x)`)),
              `${symbol} in ${used}`,
            ).toBe(true);
          }
        }
      }),
    );
  });

  it("finds a keyword in its plural and its plural in the singular", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{4,10}$/).filter((w) => !/[iusy]$/.test(w)),
        (w) => {
          const keyword = (k: string, text: string) =>
            keywordMatches(keywordOf(k), bundleText(text));
          expect(keyword(w, `+ // ${w}s`)).toBe(true);
          expect(keyword(`${w}s`, `+ // ${w}`)).toBe(true);
        },
      ),
    );
  });

  it("finds a Chinese keyword inside a longer run of Chinese text", () => {
    const han = fc.stringMatching(/^[一-龥]{1,6}$/);
    fc.assert(
      fc.property(han, han, han, (before, keyword, after) => {
        const text = bundleText(`+ // ${before}${keyword}${after}`);
        expect(keywordMatches(keywordOf(keyword), text)).toBe(true);
      }),
    );
  });
});
