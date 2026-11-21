import { describe, expect, it } from "vitest";
import type { Learning } from "./learning.js";
import { CASES, CORPUS, type RecallCase } from "./recall-corpus.fakes.js";
import { defaultLearningPolicy, indexLearnings, selectLearnings } from "./select.js";

// Selection recall is the knowledge layer's first quality bar: a learning a
// change needs and does not get is a bug ocra lets through again. The target
// is at least 95% of the needed learnings shown in full, with nothing
// unrelated shown in full.
const MIN_RECALL = 0.95;

interface Outcome {
  name: string;
  missedInFull: string[];
  missedEverywhere: string[];
  unrelatedInFull: string[];
  chars: number;
}

function run(cases: readonly RecallCase[], learnings: readonly Learning[]): Outcome[] {
  const index = indexLearnings(learnings);
  return cases.map((c) => {
    const selection = selectLearnings(index, c);
    const full = new Set(selection.included.map((m) => m.learning.id));
    const surfaced = new Set([...full, ...selection.indexed.map((m) => m.learning.id)]);
    return {
      name: c.name,
      missedInFull: c.expected.filter((id) => !full.has(id)),
      missedEverywhere: c.expected.filter((id) => !surfaced.has(id)),
      unrelatedInFull: (c.unrelated ?? []).filter((id) => full.has(id)),
      chars: selection.included.reduce((sum, m) => sum + m.learning.body.length, 0),
    };
  });
}

function recall(outcomes: readonly Outcome[], key: "missedInFull" | "missedEverywhere") {
  const expected = CASES.reduce((sum, c) => sum + c.expected.length, 0);
  const missed = outcomes.reduce((sum, o) => sum + o[key].length, 0);
  return (expected - missed) / expected;
}

// Many learnings about other parts of a large repository, sharing the
// corpus's vocabulary, so that only paths and symbols can tell them apart.
function distractors(count: number): Learning[] {
  const words = ["pool", "retry", "token", "cache", "session", "timeout", "query", "price"];
  return Array.from({ length: count }, (_, i) => ({
    id: `other-${String(i).padStart(4, "0")}`,
    title: `Legacy ${words[i % words.length]} handling in module ${i}`,
    paths: [`legacy/module-${i}/**`],
    symbols: [`legacyHelper${i}`],
    keywords: [`${words[i % words.length]} ${words[(i + 3) % words.length]}`],
    critical: i % 10 === 0,
    body: `Module ${i} handles ${words[i % words.length]} and ${words[(i + 1) % words.length]} its own way.`,
  }));
}

describe("learning selection recall", () => {
  it.each([
    { name: "the corpus", learnings: CORPUS },
    { name: "the corpus among 2,000 distractors", learnings: [...distractors(2_000), ...CORPUS] },
  ])("shows at least 95% of the needed learnings in full on $name", ({ learnings }) => {
    const outcomes = run(CASES, learnings);
    const misses = outcomes.filter((o) => o.missedInFull.length > 0);
    expect(
      recall(outcomes, "missedInFull"),
      JSON.stringify(misses, null, 2),
    ).toBeGreaterThanOrEqual(MIN_RECALL);
  });

  it("surfaces every needed learning, in full or in the index", () => {
    const outcomes = run(CASES, [...distractors(2_000), ...CORPUS]);
    expect(outcomes.filter((o) => o.missedEverywhere.length > 0)).toEqual([]);
  });

  it("shows nothing labelled unrelated in full", () => {
    const outcomes = run(CASES, [...distractors(2_000), ...CORPUS]);
    expect(outcomes.filter((o) => o.unrelatedInFull.length > 0)).toEqual([]);
  });

  it("shows no distractor in full", () => {
    const index = indexLearnings([...distractors(2_000), ...CORPUS]);
    for (const c of CASES) {
      const selection = selectLearnings(index, c);
      const shown = selection.included.map((m) => m.learning.id);
      expect(
        shown.filter((id) => id.startsWith("other-")),
        c.name,
      ).toEqual([]);
    }
  });

  it("keeps every change within the policy's size", () => {
    for (const outcome of run(CASES, CORPUS)) {
      expect(outcome.chars, outcome.name).toBeLessThanOrEqual(defaultLearningPolicy.maxChars);
    }
  });

  it("selects for a change as fast as a review needs, among 2,000 learnings", () => {
    const index = indexLearnings([...distractors(2_000), ...CORPUS]);
    const started = performance.now();
    for (const c of CASES) selectLearnings(index, c);
    expect((performance.now() - started) / CASES.length).toBeLessThan(50);
  });
});
