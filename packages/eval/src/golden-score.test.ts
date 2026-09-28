import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputFinding } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { applyLabels, labelsFor, readLabels } from "./adjudicate.js";
import { main } from "./cli.js";
import { compareSummaries, comparisonWarnings, type SavedSummary } from "./compare.js";
import { parseCase, toInstance } from "./golden.js";
import { scoreGolden } from "./golden-score.js";
import type { InstanceResult } from "./runner.js";

const base = {
  repo: "o/r",
  base: "a".repeat(40),
  head: "b".repeat(40),
  language: "TypeScript",
  tier: "smoke",
  source: { kind: "ocra-history", ref: "r" },
  rationale: "r",
};
const expectLogin = {
  file: "src/login.ts",
  lines: [10, 12],
  category: "correctness",
  minSeverity: "warning",
  concern: "The session is never cleared.",
};

function finding(fingerprint: string, overrides: Partial<OutputFinding> = {}): OutputFinding {
  return {
    fingerprint,
    reviewer: "correctness",
    category: "correctness",
    severity: "warning",
    verification: "confirmed",
    file: "src/login.ts",
    lines: { start: 40, end: 40 },
    inDiff: true,
    status: "new",
    title: `finding ${fingerprint}`,
    body: "body",
    evidence: [],
    code: "x",
    ...overrides,
  };
}

const reviewed = (id: string, findings: OutputFinding[]): InstanceResult => ({
  id,
  status: "reviewed",
  durationMs: 1,
  findings,
  usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  tasks: [],
});

// Same file and overlapping lines is enough for this judge.
const judge = { sameIssue: async () => true };

describe("scoreGolden", () => {
  it("counts matches and labels in precision, and lists what is unlabeled", async () => {
    const instance = toInstance(
      parseCase(
        {
          ...base,
          id: "login",
          expect: [expectLogin],
          forbid: [{ file: "src/login.ts", lines: [60, 70], reason: "Deliberate fallback." }],
          adjudicated: [
            { fingerprint: "0000000000000002", label: "valid", reason: "real", title: "t" },
            { fingerprint: "0000000000000003", label: "invalid", reason: "wrong", title: "t" },
          ],
        },
        "login.json",
      ),
    );
    const summary = await scoreGolden(
      [instance],
      [
        reviewed("login", [
          finding("0000000000000001", { lines: { start: 11, end: 11 } }),
          finding("0000000000000002"),
          finding("0000000000000003"),
          finding("0000000000000004", { lines: { start: 65, end: 65 } }),
          finding("0000000000000005"),
        ]),
      ],
      judge,
    );
    expect(summary.counts).toEqual({
      expected: 1,
      reported: 5,
      matched: 1,
      correct: 1,
      underrated: 0,
      valid: 1,
      invalid: 1,
      forbidden: 1,
      unadjudicated: 1,
    });
    // (1 matched + 1 valid) / 5 reported; the unlabeled one is not guessed.
    expect(summary.precision).toBeCloseTo(0.4);
    expect(summary.recall).toBe(1);
    expect(summary.unadjudicated.map((f) => f.fingerprint)).toEqual(["0000000000000005"]);
    expect(summary.failures).toEqual([]);
  });

  it("fails a critical finding in a forbidden range or on a clean case", async () => {
    const forbidding = toInstance(
      parseCase(
        {
          ...base,
          id: "forbid",
          forbid: [{ file: "src/login.ts", lines: [40, 40], reason: "Deliberate." }],
        },
        "f",
      ),
    );
    const clean = toInstance(parseCase({ ...base, id: "clean", clean: true }, "c"));
    const summary = await scoreGolden(
      [forbidding, clean],
      [
        reviewed("forbid", [
          finding("0000000000000001", { severity: "critical" }),
          finding("0000000000000002", { severity: "warning" }),
        ]),
        reviewed("clean", [finding("0000000000000003", { severity: "critical" })]),
      ],
      judge,
    );
    expect(summary.failures.map((f) => [f.case, f.fingerprint, f.reason])).toEqual([
      ["forbid", "0000000000000001", "Deliberate."],
      ["clean", "0000000000000003", "the case has no issue"],
    ]);
  });
});

describe("adjudication", () => {
  it("records labels once, turns valid findings into expectations and keeps typed labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-adjudicate-"));
    await writeFile(join(dir, "clean.json"), JSON.stringify({ ...base, id: "clean", clean: true }));
    const found = (fingerprint: string) => ({
      case: "clean",
      fingerprint,
      category: "security",
      severity: "warning" as const,
      file: "src/login.ts",
      lines: { start: 5, end: 6 },
      title: `title ${fingerprint}`,
      body: "b",
    });
    const labels = labelsFor(dir, [found("0000000000000001"), found("0000000000000002")]);
    const typed = labels.entries[0];
    if (typed) Object.assign(typed, { label: "valid", reason: "Real injection." });
    // Rescoring keeps what was typed.
    const rescored = labelsFor(dir, [found("0000000000000001"), found("0000000000000002")], labels);
    expect(rescored.entries.map((e) => e.label)).toEqual(["valid", null]);

    expect(await applyLabels(rescored, dir)).toEqual({
      applied: 1,
      pending: 1,
      alreadyRecorded: 0,
    });
    expect(await applyLabels(rescored, dir)).toMatchObject({ applied: 0, alreadyRecorded: 1 });
    const saved = parseCase(JSON.parse(await readFile(join(dir, "clean.json"), "utf8")), "clean");
    expect(saved.clean).toBe(false);
    expect(saved.adjudicated).toEqual([
      {
        fingerprint: "0000000000000001",
        label: "valid",
        reason: "Real injection.",
        title: "title 0000000000000001",
      },
    ]);
    expect(saved.expect).toEqual([
      {
        file: "src/login.ts",
        lines: [5, 6],
        category: "security",
        minSeverity: "suggestion",
        concern: "title 0000000000000001",
        also: [],
      },
    ]);
  });

  it("refuses a case id that could name a file outside the directory", async () => {
    const labels = labelsFor("/tmp", []);
    labels.entries.push({
      case: "../../etc/x",
      fingerprint: "0000000000000001",
      category: "correctness",
      severity: "warning",
      file: "a",
      title: "t",
      body: "b",
      label: "invalid",
      reason: "r",
    });
    await expect(applyLabels(labels, "/tmp")).rejects.toThrow('invalid case id "../../etc/x"');
  });
});

describe("compareSummaries", () => {
  const saved = (precision: number, cost: number): SavedSummary =>
    ({
      summary: {
        overall: { metrics: { precision, recall: 0.5, f1: 0.5 } },
        costPerReviewedUsd: cost,
        durationSeconds: { median: 60 },
      },
    }) as unknown as SavedSummary;

  it("calls a difference within the baselines' spread no change", () => {
    const rows = compareSummaries(saved(0.3, 1), saved(0.34, 0.5), saved(0.25, 1));
    const row = (name: string) => rows.find((r) => r.metric === name);
    expect(row("Precision")).toMatchObject({ verdict: "no change" });
    expect(row("Cost per reviewed PR ($)")).toMatchObject({ verdict: "better", spread: 0 });
    expect(compareSummaries(saved(0.3, 1), saved(0.2, 1), saved(0.25, 1))[0]).toMatchObject({
      verdict: "worse",
    });
  });

  it("does not judge the direction without a second baseline", () => {
    expect(compareSummaries(saved(0.3, 1), saved(0.9, 1))[0]).toMatchObject({
      verdict: "unknown",
    });
  });

  it("compares run directories from the command line and warns when their PRs differ", async () => {
    const run = async (precision: number, ids: string[]) => {
      const dir = await mkdtemp(join(tmpdir(), "ocra-compare-"));
      await writeFile(join(dir, "summary.json"), JSON.stringify(saved(precision, 1)));
      await writeFile(join(dir, "run.json"), JSON.stringify({ ids }));
      return dir;
    };
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    const code = await main(
      [
        "compare",
        await run(0.3, ["a"]),
        await run(0.5, ["b"]),
        "--spread-of",
        await run(0.28, ["a"]),
      ],
      out,
      out,
    );
    expect(code).toBe(0);
    expect(text).toContain("| Precision | 30.0% | 50.0% | +20.0% | 2.0% | better |");
    expect(text).toContain("Warning: the runs reviewed different PRs");
  });
});

describe("golden scoring edge cases", () => {
  const login = (overrides: Record<string, unknown> = {}) =>
    toInstance(parseCase({ ...base, id: "login", expect: [expectLogin], ...overrides }, "c"));
  const at = (line: number, overrides: Partial<OutputFinding> = {}) =>
    finding("0000000000000009", { lines: { start: line, end: line }, ...overrides });

  it("counts a match below the case's minimum severity for precision, not recall", async () => {
    const summary = await scoreGolden(
      [login()],
      [reviewed("login", [at(11, { severity: "suggestion" })])],
      judge,
    );
    expect(summary.counts).toMatchObject({ matched: 1, underrated: 1 });
    expect(summary.precision).toBe(1);
    expect(summary.recall).toBe(0);
  });

  it("fails only unmatched, unlabeled criticals in a forbidden range or on a clean case", async () => {
    const forbidding = login({
      forbid: [{ file: "src/login.ts", lines: [10, 12], reason: "r" }],
      adjudicated: [
        { fingerprint: "0000000000000007", label: "valid", reason: "real", title: "t" },
      ],
    });
    const summary = await scoreGolden(
      [forbidding],
      [
        reviewed("login", [
          // Matches the expected finding although it overlaps the range.
          at(11, { severity: "critical" }),
          // A critical outside any range on a case that is not clean.
          finding("0000000000000008", { severity: "critical", lines: { start: 90, end: 90 } }),
          // Labeled valid by the maintainer.
          finding("0000000000000007", { severity: "critical", lines: { start: 12, end: 12 } }),
        ]),
      ],
      judge,
    );
    expect(summary.failures).toEqual([]);
  });

  it("skips results that were not reviewed", async () => {
    const summary = await scoreGolden(
      [login()],
      [{ ...reviewed("login", [at(11)]), status: "failed" }],
      judge,
    );
    expect(summary.counts).toMatchObject({ expected: 0, reported: 0 });
  });

  it("lists a label reused for a different title, and fingerprints cases and labels", async () => {
    const labeled = login({
      adjudicated: [
        { fingerprint: "0000000000000009", label: "valid", reason: "r", title: "old claim" },
      ],
    });
    const summary = await scoreGolden(
      [labeled],
      [reviewed("login", [at(80, { title: "a new claim" })])],
      judge,
    );
    expect(summary.relabeled.map((f) => [f.title, f.labeledTitle])).toEqual([
      ["a new claim", "old claim"],
    ]);
    const unlabeled = await scoreGolden([login()], [], judge);
    expect(unlabeled.casesHash).not.toBe(summary.casesHash);
  });
});

describe("adjudication safety", () => {
  const entry = (caseId: string, overrides: Record<string, unknown> = {}) => ({
    case: caseId,
    fingerprint: "0000000000000001",
    category: "correctness",
    severity: "warning" as const,
    file: "src/login.ts",
    lines: { start: 5, end: 6 },
    title: "t",
    body: "b",
    label: "valid" as const,
    reason: "real",
    ...overrides,
  });

  it("refuses a valid finding without lines on a clean case, and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-adjudicate-"));
    const clean = JSON.stringify({ ...base, id: "clean", clean: true });
    await writeFile(join(dir, "clean.json"), clean);
    const labels = { goldenDir: dir, entries: [entry("clean", { lines: undefined })] };
    await expect(applyLabels(labels, dir)).rejects.toThrow("labeled valid on a clean case");
    expect(await readFile(join(dir, "clean.json"), "utf8")).toBe(clean);
  });

  it("writes no case when a later one fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-adjudicate-"));
    const a = JSON.stringify({ ...base, id: "a", expect: [expectLogin] });
    await writeFile(join(dir, "a.json"), a);
    await writeFile(
      join(dir, "b.json"),
      JSON.stringify({ ...base, id: "b", expect: [expectLogin] }),
    );
    const labels = {
      goldenDir: dir,
      entries: [entry("a"), entry("b", { lines: { start: 0, end: 1 } })],
    };
    await expect(applyLabels(labels, dir)).rejects.toThrow("b.json");
    expect(await readFile(join(dir, "a.json"), "utf8")).toBe(a);
  });

  it("names the file when the labels are malformed, and treats only a missing file as none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-labels-"));
    expect(await readLabels(dir)).toBeUndefined();
    await writeFile(join(dir, "adjudication.json"), JSON.stringify({ goldenDir: 1, entries: [] }));
    await expect(readLabels(dir)).rejects.toThrow(/adjudication\.json: goldenDir: /);
    await writeFile(join(dir, "adjudication.json"), "{");
    await expect(readLabels(dir)).rejects.toThrow(/adjudication\.json: not valid JSON/);
  });
});

describe("comparisonWarnings", () => {
  const run = (overrides: Record<string, unknown> = {}): SavedSummary =>
    ({
      info: { judge: "j", selection: { dataset: "golden" } },
      summary: {
        instances: { reviewed: 5 },
        golden: { casesHash: "h1", counts: { unadjudicated: 0 } },
      },
      ...overrides,
    }) as unknown as SavedSummary;

  it("names every difference that is not the change under test", () => {
    expect(comparisonWarnings([run(), run()])).toEqual([]);
    expect(
      comparisonWarnings([
        run(),
        run({
          info: { judge: "mock", selection: { dataset: "golden" } },
          summary: {
            instances: { reviewed: 4 },
            golden: { casesHash: "h2", counts: { unadjudicated: 2 } },
          },
        }),
      ]),
    ).toEqual([
      "the runs were scored by different judges",
      "the runs reviewed a different number of PRs (failed ones are not scored)",
      "the runs were scored against different golden cases or labels; rescore them",
      "some findings are unlabeled, which lowers golden precision until labeled",
    ]);
  });
});

describe("rescoring", () => {
  it("refuses a run.json whose ids would leave the run directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-rescore-"));
    await writeFile(
      join(dir, "run.json"),
      JSON.stringify({ info: { selection: {} }, ids: ["../../etc/hosts"] }),
    );
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    expect(await main(["score", dir, "--mock-judge"], out, out)).toBe(2);
    expect(text).toContain('run.json lists an invalid id "../../etc/hosts"');
  });
});

describe("alternate locations", () => {
  it("finds an expected issue at an alternate once, and counts every matching report correct", async () => {
    const instance = toInstance(
      parseCase(
        {
          ...base,
          id: "gitignore",
          expect: [{ ...expectLogin, also: [{ file: "docs/cli.mdx", lines: [58, 58] }] }],
        },
        "c",
      ),
    );
    const atDocs = finding("0000000000000001", {
      file: "docs/cli.mdx",
      lines: { start: 58, end: 58 },
    });
    const alone = await scoreGolden([instance], [reviewed("gitignore", [atDocs])], judge);
    expect(alone.counts).toMatchObject({ expected: 1, matched: 1, correct: 1 });
    expect([alone.precision, alone.recall]).toEqual([1, 1]);
    const both = await scoreGolden(
      [instance],
      [
        reviewed("gitignore", [
          atDocs,
          finding("0000000000000002", { lines: { start: 11, end: 11 } }),
        ]),
      ],
      judge,
    );
    expect(both.counts).toMatchObject({ expected: 1, matched: 1, correct: 2 });
    expect([both.precision, both.recall]).toEqual([1, 1]);
  });
});
