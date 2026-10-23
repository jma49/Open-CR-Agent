import { describe, expect, it } from "vitest";
import { parseRecords } from "./dataset.js";
import { parseCandidate, parseCase } from "./golden.js";
import {
  candidateFor,
  facts,
  fixture,
  model,
  options,
  reaches,
  record,
} from "./golden-import.fakes.js";
import {
  byLanguage,
  importCandidates,
  pickInTurn,
  toGoldenCase,
  verdictFor,
} from "./golden-import.js";

const prs = (rows = fixture) =>
  importCandidates(rows, options).map((c) => c.instance.prUrl.split("/").pop());

describe("importCandidates", () => {
  it("keeps pull requests with an in-scope comment on the new side", () => {
    expect(prs()).toEqual(["1", "8", "9", "10"]);
    const first = candidateFor(1, fixture);
    expect(first.issues.map((i) => i.row)).toEqual([0]);
    expect(first.instance.references).toHaveLength(1);
  });

  it("caps the comments people wrote, not the ones models wrote", () => {
    const rows = parseRecords([
      record(11),
      ...[20, 30, 40, 50].map((line) => record(11, { from_line: line, ...model() })),
      ...[10, 20, 30, 40].map((line) => record(12, { from_line: line })),
    ]);
    expect(prs(rows)).toEqual(["11"]);
    expect(candidateFor(11, rows).issues).toHaveLength(5);
  });

  it("leaves out a comment on removed lines instead of the pull request", () => {
    const rows = parseRecords([record(13), record(13, { side: "left", from_line: 50 })]);
    const candidate = candidateFor(13, rows);
    expect(candidate.issues.map((i) => i.row)).toEqual([0]);
    expect(candidate.leftOut).toEqual([
      { row: 1, path: "server/handler.go", reason: "on removed lines" },
    ]);
  });
});

describe("byLanguage and pickInTurn", () => {
  it("takes one acceptable case per language in turn, up to the limit", async () => {
    const queues = byLanguage(importCandidates(fixture, options), 1);
    expect(queues.map((q) => q[0]?.instance.language)).toEqual(["C", "Go", "Rust"]);
    const seen: string[] = [];
    const picked = await pickInTurn(
      queues,
      3,
      async (c) => {
        seen.push(c.instance.id);
        return c.instance.language === "C"
          ? { rejected: "not reachable" }
          : verdictFor(c, reaches(c), facts);
      },
      () => {},
    );
    expect(picked.map((p) => p.case.language)).toEqual(["Go", "Rust", "Rust"]);
    expect(seen).toHaveLength(4);
  });
});

describe("verdictFor", () => {
  const rows = parseRecords([
    record(14),
    record(14, { from_line: 60, path: "server/cache.go" }),
    record(14, { from_line: 80, ...model() }),
    record(14, { label: 0, from_line: 90, note: "wrong:\n the map is guarded" }),
  ]);
  const candidate = candidateFor(14, rows);

  it("keeps the reachable comments and names the others with their reason", () => {
    const verdict = verdictFor(candidate, reaches(candidate, new Set([60])), facts);
    if (!("case" in verdict)) throw new Error(verdict.rejected);
    expect(verdict.case.expect.map((e) => e.id)).toEqual(["row-0", "row-2"]);
    expect(verdict.case.rationale).toContain("Left out: row 1 (server/cache.go, outside_diff).");
  });

  it("skips the pull request when no comment is reachable", () => {
    const verdict = verdictFor(candidate, reaches(candidate, new Set([10, 60, 80])), facts);
    expect(verdict).toEqual({
      rejected:
        "not reachable: server/handler.go (outside_diff), server/cache.go (outside_diff), server/handler.go (outside_diff)",
    });
  });

  it("records the licence and date found at head", () => {
    const verdict = verdictFor(candidate, reaches(candidate), facts);
    if (!("case" in verdict)) throw new Error(verdict.rejected);
    expect(verdict.case.source).toMatchObject({ licence: "MIT", date: "2025-03-01" });
    expect(verdict.case.source.ref).toContain("licence MIT read from LICENSE");
    expect(() => parseCase(JSON.parse(JSON.stringify(verdict.case)), "c.json")).not.toThrow();
  });

  it("hands comments labelled incorrect over as forbid seeds, outside the case", () => {
    const verdict = verdictFor(candidate, reaches(candidate), facts);
    if (!("case" in verdict)) throw new Error(verdict.rejected);
    expect(verdict.case.expect.map((e) => e.id)).not.toContain("row-3");
    expect(verdict.case.forbid).toEqual([]);
    expect(verdict.forbidSeeds).toEqual([
      {
        case: "aacr-api-0000014",
        row: 3,
        file: "server/handler.go",
        side: "right",
        lines: [90, 90],
        category: "Code Defect",
        isAiComment: false,
        producer: "human",
        note: "wrong: the map is guarded",
      },
    ]);
  });

  it("keeps at most five of the models' comments, in row order", () => {
    const many = parseRecords(
      [10, 20, 30, 40, 50, 60, 70].map((line) => record(15, { from_line: line, ...model() })),
    );
    const c = candidateFor(15, many);
    const verdict = verdictFor(c, reaches(c), facts);
    if (!("case" in verdict)) throw new Error(verdict.rejected);
    expect(verdict.case.expect.map((e) => e.id)).toEqual([
      "row-0",
      "row-1",
      "row-2",
      "row-3",
      "row-4",
    ]);
    expect(verdict.case.rationale).toContain(
      "row 5 (server/handler.go, past the cap of 5 optional claims)",
    );
    expect(verdict.case.rationale).toContain("vet this case after those with people's");
  });
});

describe("toGoldenCase", () => {
  const security = candidateFor(8, fixture);

  it("writes a candidate that names its rows and says it is unverified", () => {
    const golden = toGoldenCase(security, facts);
    expect(parseCandidate(JSON.parse(JSON.stringify(golden)), "round trip")).toEqual(golden);
    expect(golden).toMatchObject({
      id: "aacr-api-0000008",
      base: "c".repeat(40),
      head: `0000008${"b".repeat(33)}`,
      tier: "full",
      source: { kind: "aacr", licence: "MIT", date: "2025-03-01" },
      adjudicated: [],
      forbid: [],
      expect: [
        {
          id: "row-12",
          file: "server/handler.go",
          lines: [10, 10],
          category: "security",
          minSeverity: "suggestion",
          concern: "nil map write panics when the cache is cold",
          origin: "human-review",
          producer: "human",
          optional: false,
        },
      ],
    });
    expect(golden.source.ref).toContain("rows 12");
    expect(golden.source.ref).toContain("not hand-checked");
    expect(golden.rationale).toMatch(/^Unverified/);
  });

  it("records a model-written comment as the model's, and optional until vetted", () => {
    const ai = parseRecords([record(11, { ...model(), category: "Code Defect" })]);
    expect(toGoldenCase(candidateFor(11, ai), facts).expect[0]).toMatchObject({
      origin: "ai-reference-vetted",
      producer: "GLM-4.7",
      optional: true,
    });
  });

  it("leaves an undetermined licence for a person to check: no case loads without one", () => {
    const unknown = { ...facts, licence: { licence: "NOASSERTION", note: "n" } } as const;
    const golden = toGoldenCase(security, unknown);
    expect(() => parseCase(JSON.parse(JSON.stringify(golden)), "candidate.json")).toThrow(
      "candidate.json: source.licence: check the repository's licence",
    );
  });

  it("shortens a long comment to a concern", () => {
    const concern = toGoldenCase(candidateFor(10, fixture), facts).expect[0]?.concern ?? "";
    expect(concern.length).toBeLessThanOrEqual(502);
    expect(concern.endsWith(" …") || concern.endsWith("…")).toBe(true);
  });
});
