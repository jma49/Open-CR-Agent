import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./cli.js";
import { loadGolden, parseCase, toInstance, untouchedPaths } from "./golden.js";
import { selectInstances } from "./select.js";

const valid = {
  id: "ocra-anchor-crlf",
  repo: "jma49/Open-CR-Agent",
  base: "a".repeat(40),
  head: "b".repeat(40),
  language: "TypeScript",
  tier: "smoke",
  source: { kind: "ocra-history", ref: "fixed by c".padEnd(20, "0") },
  rationale: "Anchoring broke on CRLF files.",
  expect: [
    {
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
    const dir = await caseDir(valid, {
      ...valid,
      id: "clean-refactor",
      tier: "full",
      expect: [],
      forbid: [],
      clean: true,
    });
    const out = output();
    const err = output();
    const list = (...args: string[]) =>
      main(["list", "--dataset", "golden", "--golden-dir", dir, ...args], out, err);
    expect(await list("--tier", "smoke")).toBe(0);
    expect(out.text()).toContain("ocra-anchor-crlf\tTypeScript\tsmoke\t1 forbidden\t1 issues");
    expect(out.text()).not.toContain("clean-refactor");
    expect(await list()).toBe(0);
    expect(out.text()).toContain("clean-refactor\tTypeScript\tfull\tclean\t0 issues");
  });

  it("refuses --tier without the golden dataset", async () => {
    const err = output();
    expect(await main(["list", "--tier", "smoke"], output(), err)).toBe(2);
    expect(err.text()).toContain("--tier needs --dataset golden");
  });
});
