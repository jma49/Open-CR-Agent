import { describe, expect, it } from "vitest";
import type { ReferenceComment } from "./dataset.js";
import { MockJudge, parseJudgeAnswer } from "./judges.js";
import { type GeneratedComment, matchComments, type SemanticJudge } from "./match.js";
import { countMatches, qualityMetrics } from "./metrics.js";

const ref = (overrides: Partial<ReferenceComment> = {}): ReferenceComment => ({
  path: "src/a.ts",
  side: "right",
  fromLine: 10,
  toLine: 12,
  note: "null dereference when user missing",
  category: "Code Defect",
  context: "Diff Level",
  ...overrides,
});
const gen = (overrides: Partial<GeneratedComment> = {}): GeneratedComment => ({
  path: "src/a.ts",
  side: "right",
  fromLine: 11,
  toLine: 11,
  note: "null dereference when user missing",
  ...overrides,
});
const always: SemanticJudge = { sameIssue: async () => true };
const never: SemanticJudge = { sameIssue: async () => false };

describe("matchComments", () => {
  it("requires the same path and side", async () => {
    expect(
      (await matchComments([ref()], [gen({ path: "src/b.ts" })], always))[0]?.semanticMatch,
    ).toBe(false);
    expect((await matchComments([ref()], [gen({ side: "left" })], always))[0]?.semanticMatch).toBe(
      false,
    );
    expect(
      (await matchComments([ref({ path: "src\\a.ts" })], [gen()], always))[0]?.semanticMatch,
    ).toBe(true);
  });

  it("accepts overlapping ranges or a gap of one line", async () => {
    const at = async (fromLine: number, toLine: number) =>
      (await matchComments([ref()], [gen({ fromLine, toLine })], always))[0]?.lineMatch;
    expect(await at(12, 20)).toBe(true);
    expect(await at(13, 13)).toBe(true);
    expect(await at(14, 14)).toBe(false);
    expect(await at(8, 9)).toBe(true);
    expect(await at(1, 8)).toBe(false);
  });

  it("skips the line stage when either side has no range", async () => {
    const [match] = await matchComments([ref()], [gen({ fromLine: null, toLine: null })], always);
    expect(match).toMatchObject({ lineMatch: true, semanticMatch: true });
  });

  it("counts a line match even when the judge disagrees", async () => {
    const [match] = await matchComments([ref()], [gen()], never);
    expect(match).toMatchObject({ lineMatch: true, semanticMatch: false });
  });

  it("lets each generated comment match only one reference", async () => {
    const matches = await matchComments(
      [ref(), ref({ note: "same place, other wording" })],
      [gen()],
      always,
    );
    expect(matches.map((m) => [m.lineMatch, m.semanticMatch])).toEqual([
      [true, true],
      [false, false],
    ]);
    const counts = countMatches(matches, 1);
    expect(qualityMetrics(counts)).toMatchObject({ precision: 1, recall: 0.5 });
  });
});

describe("qualityMetrics", () => {
  it("computes precision, recall, f1 and line variants", () => {
    const metrics = qualityMetrics({
      expected: 12,
      generated: 8,
      lineMatches: 7,
      semanticMatches: 6,
    });
    expect(metrics.precision).toBeCloseTo(0.75);
    expect(metrics.recall).toBeCloseTo(0.5);
    expect(metrics.f1).toBeCloseTo(0.6);
    expect(metrics.linePrecision).toBeCloseTo(0.875);
    expect(
      qualityMetrics({ expected: 0, generated: 0, lineMatches: 0, semanticMatches: 0 }).f1,
    ).toBe(0);
  });
});

describe("judges", () => {
  it.each([
    ["Yes", true],
    ["yes, both flag the null dereference", true],
    ["They describe the same issue.", true],
    ["No", false],
    ["No, they are not the same issue.", false],
    ["Not really; different concerns", false],
  ])("parses %j as %s", (answer, expected) => {
    expect(parseJudgeAnswer(answer)).toBe(expected);
  });

  it("mock judge uses word overlap", async () => {
    const judge = new MockJudge();
    expect(
      await judge.sameIssue(
        "null dereference when user missing",
        "user missing causes null dereference",
      ),
    ).toBe(true);
    expect(await judge.sameIssue("null dereference", "rename variable for clarity")).toBe(false);
  });
});
