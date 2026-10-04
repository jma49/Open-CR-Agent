import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputFinding } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { base, expectLogin, finding, judge, reviewed } from "./golden.fakes.js";
import { parseCase, toInstance } from "./golden.js";
import { scoreGolden } from "./golden-score.js";

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

  it("lends a label to a reworded claim the judge calls the same, lists it, and fingerprints cases and labels", async () => {
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

describe("labels belong to a claim on the code", () => {
  const labeled = (...labels: ["valid" | "invalid", string][]) =>
    toInstance(
      parseCase(
        {
          ...base,
          id: "login",
          expect: [expectLogin],
          adjudicated: labels.map(([label, title]) => ({
            fingerprint: "0000000000000009",
            label,
            reason: "r",
            title,
          })),
        },
        "c",
      ),
    );
  const onLabeledCode = (title: string) =>
    finding("0000000000000009", { lines: { start: 80, end: 80 }, title });
  // Tells claims apart: a reworded claim keeps the labeled title as its start.
  const claims = { sameIssue: async (labeled: string, claim: string) => claim.startsWith(labeled) };

  it("does not lend a valid label to another claim quoting the same code", async () => {
    const summary = await scoreGolden(
      [labeled(["valid", "The session is never cleared"])],
      [reviewed("login", [onLabeledCode("Adapters are not validated early")])],
      claims,
    );
    expect(summary.counts).toMatchObject({ reported: 1, valid: 0, unadjudicated: 1 });
    expect(summary.precision).toBe(0);
    expect(summary.unadjudicated.map((f) => f.title)).toEqual(["Adapters are not validated early"]);
    expect(summary.relabeled).toEqual([]);
  });

  it("applies the label recorded for the claim among several on the same code", async () => {
    const summary = await scoreGolden(
      [
        labeled(
          ["valid", "The session is never cleared"],
          ["invalid", "Adapters are not validated early"],
        ),
      ],
      [
        reviewed("login", [
          onLabeledCode("Adapters are not validated early"),
          onLabeledCode("The session is never cleared on logout"),
        ]),
      ],
      claims,
    );
    expect(summary.counts).toMatchObject({ valid: 1, invalid: 1, unadjudicated: 0 });
    expect(summary.relabeled.map((f) => [f.title, f.labeledTitle])).toEqual([
      ["The session is never cleared on logout", "The session is never cleared"],
    ]);
  });

  it("applies a label to its own title without asking the judge", async () => {
    const silent = {
      sameIssue: async (): Promise<boolean> => {
        throw new Error("the judge was asked");
      },
    };
    const summary = await scoreGolden(
      [labeled(["invalid", "Adapters are not validated early"])],
      [reviewed("login", [onLabeledCode("Adapters are not validated early")])],
      silent,
    );
    expect(summary.counts).toMatchObject({ invalid: 1, unadjudicated: 0 });
  });
});

describe("rescoring", () => {
  const info = {
    runId: "r",
    createdAt: "2026-10-04T00:00:00Z",
    selection: {},
    models: {},
    judge: "mock",
  };

  it("refuses a run.json whose ids would leave the run directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-rescore-"));
    await writeFile(join(dir, "run.json"), JSON.stringify({ info, ids: ["../../etc/hosts"] }));
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    expect(await main(["score", dir, "--mock-judge"], out, out)).toBe(2);
    expect(text).toContain('run.json lists an invalid id "../../etc/hosts"');
  });

  it("refuses a run.json in another shape, saying where", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ocra-rescore-"));
    await writeFile(join(dir, "run.json"), JSON.stringify({ info: { selection: {} }, ids: [] }));
    let text = "";
    const out = { write: (chunk: string) => (text += chunk) };
    expect(await main(["score", dir, "--mock-judge"], out, out)).toBe(2);
    expect(text).toContain("runId");
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
