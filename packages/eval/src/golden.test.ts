import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { loadGolden, parseCandidate, parseCase, toInstance, untouchedPaths } from "./golden.js";
import { selectInstances } from "./select.js";

const valid = {
  id: "ocra-anchor-crlf",
  repo: "jma49/Open-CR-Agent",
  base: "a".repeat(40),
  head: "b".repeat(40),
  language: "TypeScript",
  tier: "smoke",
  source: {
    kind: "ocra-history",
    ref: "fixed by c".padEnd(20, "0"),
    licence: "Apache-2.0",
    date: "2026-09-27",
  },
  rationale: "Anchoring broke on CRLF files.",
  expect: [
    {
      id: "crlf-quote",
      origin: "author-fix",
      producer: "human",
      file: "packages/core/src/anchor.ts",
      lines: [10, 12],
      category: "correctness",
      minSeverity: "warning",
      concern: "CRLF line endings break the quote match.",
    },
  ],
  forbid: [{ file: "packages/core/src/anchor.ts", lines: [30, 30], reason: "Intended fallback." }],
};

const output = () => {
  let text = "";
  return { write: (chunk: string) => (text += chunk), text: () => text };
};

async function caseDir(...cases: Record<string, unknown>[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ocra-golden-"));
  for (const c of cases) await writeFile(join(dir, `${c.id}.json`), JSON.stringify(c));
  return dir;
}

describe("golden cases", () => {
  it("loads a case as an instance whose references come from expect", () => {
    const instance = toInstance(parseCase(valid, "case.json"));
    expect(instance).toMatchObject({
      id: "ocra-anchor-crlf",
      repo: "jma49/Open-CR-Agent",
      baseCommit: valid.base,
      headCommit: valid.head,
      references: [
        {
          path: "packages/core/src/anchor.ts",
          side: "right",
          fromLine: 10,
          toLine: 12,
          category: "Code Defect",
          note: "CRLF line endings break the quote match.",
        },
      ],
      golden: {
        tier: "smoke",
        clean: false,
        forbid: [
          {
            path: "packages/core/src/anchor.ts",
            fromLine: 30,
            toLine: 30,
            reason: "Intended fallback.",
          },
        ],
      },
    });
  });

  it.each([
    [
      "a path that leaves the repository",
      { expect: [{ ...valid.expect[0], file: "../etc/passwd" }] },
    ],
    ["an absolute path", { forbid: [{ ...valid.forbid[0], file: "/etc/passwd" }] }],
    ["a reversed line range", { expect: [{ ...valid.expect[0], lines: [12, 10] }] }],
    ["a commit that git could read as an option", { head: "--upload-pack=x" }],
    ["a repository that is not owner/name", { repo: "https://evil.example/x" }],
    ["an unknown key", { expected: [] }],
    ["an unknown category", { expect: [{ ...valid.expect[0], category: "style" }] }],
    ["a clean case that expects findings", { clean: true }],
    ["a case with nothing to check", { expect: [], forbid: [] }],
  ])("rejects %s", (_name, change) => {
    expect(() => parseCase({ ...valid, ...change }, "case.json")).toThrow(/^case\.json: /);
  });

  const claim = (id: string, optional = false) => ({ ...valid.expect[0], id, optional });

  it.each([
    [
      "a fourth required claim",
      { expect: ["a", "b", "c", "d"].map((id) => claim(id)) },
      "case: a case has at most 3 required claims",
    ],
    [
      "a sixth optional claim",
      { expect: ["a", "b", "c", "d", "e", "f"].map((id) => claim(id, true)) },
      "case: a case has at most 5 optional claims",
    ],
    [
      "a fourth forbid range",
      { forbid: [1, 2, 3, 4].map((n) => ({ ...valid.forbid[0], lines: [n, n] })) },
      "forbid: Too big",
    ],
    [
      "two claims with one id",
      { expect: [claim("a"), claim("a", true)] },
      "case: claim ids are unique",
    ],
    ["a claim id that is not a slug", { expect: [claim("Fix #1")] }, "expect.0.id: must be"],
    [
      "a claim without an origin",
      { expect: [{ ...claim("a"), origin: undefined }] },
      "expect.0.origin",
    ],
    [
      "a claim without a producer",
      { expect: [{ ...claim("a"), producer: "" }] },
      "expect.0.producer",
    ],
    [
      "a required suggestion only a model vouches for",
      { expect: [{ ...claim("a"), origin: "model-found-vetted", minSeverity: "suggestion" }] },
      "case: a claim only a model vouches for is required only at warning or above",
    ],
    [
      "a required claim over 15 lines",
      { expect: [{ ...claim("a"), lines: [10, 25] }] },
      "case: a required claim spans at most 15 lines",
    ],
  ])("caps and identifies claims: rejects %s", (_name, change, message) => {
    expect(() => parseCase({ ...valid, ...change }, "case.json")).toThrow(`case.json: ${message}`);
  });

  it("leaves model-vouched suggestions and wide ranges to optional claims and candidates", () => {
    const suggestion = {
      ...claim("a", true),
      origin: "ai-reference-vetted",
      minSeverity: "suggestion",
    };
    expect(() => parseCase({ ...valid, expect: [suggestion] }, "case.json")).not.toThrow();
    const wide = { ...claim("b"), lines: [10, 40] };
    expect(() => parseCase({ ...valid, expect: [{ ...wide, optional: true }] }, "c")).not.toThrow();
    expect(() => parseCandidate({ ...valid, expect: [wide] }, "candidate.json")).not.toThrow();
  });

  it("accepts three required and five optional claims, with raters", () => {
    const required = ["a", "b", "c"].map((id) => claim(id));
    const optional = ["d", "e", "f", "g", "h"].map((id) => claim(id, true));
    const parsed = parseCase(
      {
        ...valid,
        expect: [...required, ...optional],
        raters: [{ by: "second-rater", date: "2026-10-23" }],
      },
      "case.json",
    );
    expect(toInstance(parsed).golden?.claims.filter((c) => c.optional)).toHaveLength(5);
  });

  it.each([
    ["SSPL-1.0"],
    ["BUSL-1.1"],
    ["Elastic-2.0"],
    ["LicenseRef-n8n-Sustainable-Use-1.0"],
    ["MIT OR Apache-2.0"],
    ["NOASSERTION"],
  ])("refuses a licence outside the allowlist: %s", (licence) => {
    expect(() =>
      parseCase({ ...valid, source: { ...valid.source, licence } }, "case.json"),
    ).toThrow("case.json: source.licence");
  });

  it.each([
    ["a missing date", undefined],
    ["a date that is not a day", "2025-02-30"],
    ["a date with a time", "2025-02-18T10:00:00Z"],
  ])("refuses %s on the source", (_name, date) => {
    expect(() => parseCase({ ...valid, source: { ...valid.source, date } }, "case.json")).toThrow(
      "case.json: source.date",
    );
  });

  it("loads every committed case", async () => {
    const committed = fileURLToPath(new URL("../../../evals/golden", import.meta.url));
    const instances = await loadGolden(committed);
    expect(instances.filter((i) => i.golden?.tier !== "adversarial").length).toBeGreaterThan(0);
  });

  it("refuses two labels for one claim on the same code", () => {
    const label = { fingerprint: "0000000000000009", label: "valid", reason: "r", title: "t" };
    expect(() =>
      parseCase({ ...valid, adjudicated: [label, { ...label, label: "invalid" }] }, "case.json"),
    ).toThrow("case.json: case: a claim on the same code (fingerprint and title) is labeled once");
    expect(() =>
      parseCase({ ...valid, adjudicated: [label, { ...label, title: "another claim" }] }, "c"),
    ).not.toThrow();
  });

  it("accepts a clean case without expectations", () => {
    const clean = parseCase({ ...valid, expect: [], forbid: [], clean: true }, "case.json");
    expect(toInstance(clean).references).toEqual([]);
  });

  it("requires the file name to match the id, once", async () => {
    const dir = await caseDir(valid);
    expect((await loadGolden(dir)).map((i) => i.id)).toEqual([valid.id]);
    await writeFile(join(dir, "other.json"), JSON.stringify(valid));
    await expect(loadGolden(dir)).rejects.toThrow('other.json: id "ocra-anchor-crlf"');
  });

  it("says where it looked when there are no cases", async () => {
    await expect(loadGolden("/nonexistent/golden")).rejects.toThrow(
      "No golden cases: /nonexistent/golden does not exist",
    );
  });

  it("names the files a case points at that the change does not touch", () => {
    const instance = toInstance(parseCase(valid, "case.json"));
    expect(untouchedPaths(instance, new Set(["packages/core/src/anchor.ts"]))).toEqual([]);
    expect(untouchedPaths(instance, new Set(["other.ts"]))).toEqual([
      "packages/core/src/anchor.ts",
    ]);
  });

  it("selects clean cases and filters by tier", () => {
    const smoke = toInstance(parseCase(valid, "a"));
    const clean = toInstance(
      parseCase({ ...valid, id: "clean", tier: "full", expect: [], forbid: [], clean: true }, "b"),
    );
    const ids = (tier?: "smoke" | "full") =>
      selectInstances([smoke, clean], { seed: 1, ...(tier ? { tier } : {}) })
        .map((i) => i.id)
        .sort();
    expect(ids("full")).toEqual(["clean", "ocra-anchor-crlf"]);
    expect(ids("smoke")).toEqual(["ocra-anchor-crlf"]);
  });

  it("lists golden cases from the command line, with no network", async () => {
    const dir = await caseDir(
      valid,
      { ...valid, id: "clean-refactor", tier: "full", expect: [], forbid: [], clean: true },
      {
        ...valid,
        id: "build-error",
        tier: "full",
        expect: [{ ...valid.expect[0], optional: true }],
      },
    );
    const out = output();
    const err = output();
    const list = (...args: string[]) =>
      main(["list", "--dataset", "golden", "--golden-dir", dir, ...args], out, err);
    expect(await list("--tier", "smoke")).toBe(0);
    expect(out.text()).toContain("ocra-anchor-crlf\tTypeScript\tsmoke\t1 forbidden\t1 issues");
    expect(out.text()).not.toContain("clean-refactor");
    expect(await list()).toBe(0);
    expect(out.text()).toContain("clean-refactor\tTypeScript\tfull\tclean\t0 issues");
    expect(out.text()).toContain(
      "build-error\tTypeScript\tfull\t1 forbidden\t1 issues (1 optional)",
    );
    expect(out.text()).toContain("3 case(s), 1 required and 1 optional claim(s)");
  });

  it("refuses --tier without the golden dataset", async () => {
    const err = output();
    expect(await main(["list", "--tier", "smoke"], output(), err)).toBe(2);
    expect(err.text()).toContain("--tier needs --dataset golden");
  });
});
