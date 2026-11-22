import { describe, expect, it } from "vitest";
import type { FileDiff } from "../domain.js";
import { MAX_LISTED_LEARNINGS } from "../review/prompt.js";
import type { Learning } from "./learning.js";
import { CASES, type RecallCase } from "./recall-cases.fakes.js";
import { CORPUS } from "./recall-corpus.fakes.js";
import { DEFAULT_SELECTION_LIMITS, learningSelector } from "./select.js";

// The replay gate of ADR-0037 (6): a learning a change needs and does not get
// is a bug ocra lets through again, so at least 95% of the needed learnings
// must be given in full, every one must at least be listed, and none
// labelled unrelated may be given.
const MIN_RECALL = 0.95;
// The most learnings a repository may hold (cloud-contract's MAX_LEARNINGS).
const MAX_LEARNINGS = 500;

interface Outcome {
  name: string;
  notGiven: string[];
  notListed: string[];
  unrelatedGiven: string[];
  distractorsGiven: string[];
  chars: number;
  tokens: number;
}

function filesOf(c: RecallCase): FileDiff[] {
  return c.paths.map((entry, i) => {
    const { from, to } = typeof entry === "string" ? { from: entry, to: entry } : entry;
    const header =
      from === to
        ? `--- a/${from}\n+++ b/${to}`
        : `similarity index 100%\nrename from ${from}\nrename to ${to}`;
    return {
      oldPath: from,
      newPath: to,
      kind: from === to ? "modified" : "renamed",
      isBinary: false,
      additions: 1,
      deletions: 0,
      hunks: [],
      patch: `diff --git a/${from} b/${to}\n${header}\n${i === 0 && c.text ? `@@ -1 +1 @@\n${c.text}` : ""}`,
    };
  });
}

// What the learnings add to a reviewer's prompt, estimated at four
// characters per token as the review preview does.
function tokensOf(given: readonly Learning[], listed: readonly Learning[]): number {
  const chars =
    given.reduce((sum, l) => sum + l.title.length + l.body.length, 0) +
    listed.reduce((sum, l) => sum + l.id.length + l.title.length + 4, 0);
  return Math.ceil(chars / 4);
}

function replay(learnings: readonly Learning[]): Outcome[] {
  const select = learningSelector(learnings);
  return CASES.map((c) => {
    const { selected, left } = select(filesOf(c));
    const listedLearnings = left.slice(0, MAX_LISTED_LEARNINGS);
    const given = new Set(selected.map((l) => l.id));
    const shown = new Set([...given, ...listedLearnings.map((l) => l.id)]);
    return {
      name: c.name,
      notGiven: c.expected.filter((id) => !given.has(id)),
      notListed: [...c.expected, ...(c.listed ?? [])].filter((id) => !shown.has(id)),
      unrelatedGiven: (c.unrelated ?? []).filter((id) => given.has(id)),
      distractorsGiven: [...given].filter((id) => id.includes("other-")),
      chars: selected.reduce((sum, l) => sum + l.body.length, 0),
      tokens: tokensOf(selected, listedLearnings),
    };
  });
}

function recall(outcomes: readonly Outcome[]): number {
  const expected = CASES.reduce((sum, c) => sum + c.expected.length, 0);
  const missed = outcomes.reduce((sum, o) => sum + o.notGiven.length, 0);
  return (expected - missed) / expected;
}

// Learnings about other parts of a large repository, in the corpus's own
// words, so that only paths and symbols tell them apart.
function distractors(count: number): Learning[] {
  const words = ["pool", "retry", "token", "cache", "session", "timeout", "query", "price"];
  return Array.from({ length: count }, (_, i) => {
    const word = words[i % words.length];
    return {
      id: `other-${String(i).padStart(4, "0")}`,
      title: `Legacy ${word} handling in module ${i}`,
      body: `Module ${i} handles ${word} and ${words[(i + 1) % words.length]} its own way.`,
      paths: [`legacy/module-${i}/**`],
      symbols: [`legacyHelper${i}`],
      keywords: [`legacy ${word} module${i}`],
      critical: i % 10 === 0,
    };
  });
}

const CROWDED = [...distractors(MAX_LEARNINGS - CORPUS.length), ...CORPUS];

// Other lessons about the same code, under ids that sort first so that no
// tie falls to the corpus by name.
function neighbours(perLearning: number): Learning[] {
  return CORPUS.flatMap((l, n) =>
    distractors(perLearning).map((d) => ({
      ...d,
      id: `a-${d.id}-${n}`,
      title: `${d.title}, part ${n}`,
      paths: l.paths,
      symbols: [`${d.symbols[0]}x${n}`],
      critical: false,
    })),
  );
}
const DENSE = [...neighbours(9), ...CORPUS];

// The ratchet on what learnings cost: the mean, over the replay, of the
// tokens they add to one reviewer's prompt. Lower it when selection gets
// tighter; a change that raises it gives reviewers more than they need.
const MAX_MEAN_TOKENS = 60;

describe.each([
  { name: "the corpus", learnings: CORPUS },
  { name: "the corpus in a full repository", learnings: CROWDED },
])("learning selection replayed on $name", ({ learnings }) => {
  const outcomes = replay(learnings);

  it(`gives at least ${MIN_RECALL * 100}% of the needed learnings in full`, () => {
    const misses = outcomes.filter((o) => o.notGiven.length > 0);
    expect(recall(outcomes), JSON.stringify(misses, null, 2)).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it("gives or lists every needed learning", () => {
    expect(outcomes.filter((o) => o.notListed.length > 0)).toEqual([]);
  });

  it("gives no learning labelled unrelated, and no distractor", () => {
    expect(
      outcomes.filter((o) => o.unrelatedGiven.length > 0 || o.distractorsGiven.length > 0),
    ).toEqual([]);
  });

  it("stays within the character budget", () => {
    for (const o of outcomes) {
      expect(o.chars, o.name).toBeLessThanOrEqual(DEFAULT_SELECTION_LIMITS.maxChars);
    }
  });

  it(`adds at most ${MAX_MEAN_TOKENS} tokens to a prompt on average`, () => {
    const mean = outcomes.reduce((sum, o) => sum + o.tokens, 0) / outcomes.length;
    expect(mean).toBeLessThanOrEqual(MAX_MEAN_TOKENS);
  });
});

// With many lessons on the same paths, a needed learning with no symbol or
// keyword in the change ties with its neighbours and may fall to the
// listing; one the change gives evidence for must still be given.
describe("learning selection replayed among other lessons on the same paths", () => {
  const outcomes = replay(DENSE);
  const byId = new Map(CORPUS.map((l) => [l.id, l]));
  const evidenced = (id: string, c: RecallCase) => {
    const l = byId.get(id);
    if (l === undefined) return false;
    return learningSelector([{ ...l, paths: ["/nowhere"] }])(filesOf(c)).selected.length === 1;
  };

  it("gives every needed learning the change has a symbol or keyword of", () => {
    const missed = CASES.flatMap((c, i) =>
      (outcomes[i]?.notGiven ?? [])
        .filter((id) => evidenced(id, c))
        .map((id) => `${c.name}: ${id}`),
    );
    expect(missed).toEqual([]);
  });
});
