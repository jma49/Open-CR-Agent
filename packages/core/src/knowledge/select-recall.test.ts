import { describe, expect, it } from "vitest";
import type { FileDiff } from "../domain.js";
import type { Learning } from "./learning.js";
import { CASES, CORPUS, type RecallCase } from "./recall-corpus.fakes.js";
import { DEFAULT_SELECTION_LIMITS, learningSelector } from "./select.js";

// The replay gate of ADR-0037 (6): a learning a change needs and does not get
// is a bug ocra lets through again, so at least 95% of the needed learnings
// must be given in full, all of them must at least be candidates, and none
// labelled unrelated may be given.
const MIN_RECALL = 0.95;
// The most learnings a repository may hold (cloud-contract's MAX_LEARNINGS).
const MAX_LEARNINGS = 500;

interface Outcome {
  name: string;
  notGiven: string[];
  notCandidates: string[];
  unrelatedGiven: string[];
  distractorsGiven: string[];
  chars: number;
}

function filesOf(c: RecallCase): FileDiff[] {
  return c.paths.map((path, i) => ({
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [],
    patch: i === 0 ? c.text : "",
  }));
}

function replay(learnings: readonly Learning[]): Outcome[] {
  const select = learningSelector(learnings);
  return CASES.map((c) => {
    const { selected, left } = select(filesOf(c));
    const given = new Set(selected.map((l) => l.id));
    const candidates = new Set([...given, ...left.map((l) => l.id)]);
    return {
      name: c.name,
      notGiven: c.expected.filter((id) => !given.has(id)),
      notCandidates: c.expected.filter((id) => !candidates.has(id)),
      unrelatedGiven: (c.unrelated ?? []).filter((id) => given.has(id)),
      distractorsGiven: [...given].filter((id) => id.startsWith("other-")),
      chars: selected.reduce((sum, l) => sum + l.body.length, 0),
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

describe.each([
  { name: "the corpus", learnings: CORPUS },
  { name: "the corpus in a full repository", learnings: CROWDED },
])("learning selection replayed on $name", ({ learnings }) => {
  const outcomes = replay(learnings);

  it(`gives at least ${MIN_RECALL * 100}% of the needed learnings in full`, () => {
    const misses = outcomes.filter((o) => o.notGiven.length > 0);
    expect(recall(outcomes), JSON.stringify(misses, null, 2)).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it("makes every needed learning a candidate", () => {
    expect(outcomes.filter((o) => o.notCandidates.length > 0)).toEqual([]);
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
});
