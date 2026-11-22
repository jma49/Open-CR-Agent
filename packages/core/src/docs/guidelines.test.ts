import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  guidelineSections,
  guidelinesForTask,
  MAX_GUIDELINES_CHARS,
  selectGuidelines,
} from "./guidelines.js";
import { GUIDELINE_CASES, MONOREPO_GUIDELINES } from "./guidelines-recall.fakes.js";

const sections = guidelineSections(MONOREPO_GUIDELINES);
const headings = (list: readonly { heading: string }[]) => list.map((s) => s.heading);

describe("guidelineSections", () => {
  it("splits a document into whole sections that join back into it", () => {
    const ours = readFileSync(new URL("../../../../AGENTS.md", import.meta.url), "utf8");
    for (const text of [
      ours,
      MONOREPO_GUIDELINES,
      "no heading at all",
      "```\n# not a heading\n```",
    ]) {
      expect(
        guidelineSections(text)
          .map((s) => s.raw)
          .join("\n"),
      ).toBe(text);
    }
    expect(headings(guidelineSections("```\n# not a heading\n```"))).toEqual([""]);
  });

  it("scopes a section only by a path in its heading, and its subsections with it", () => {
    const scopes = Object.fromEntries(sections.map((s) => [s.heading, s.scope]));
    expect(scopes).toMatchObject({
      Security: [],
      "`web/`": ["web"],
      Components: ["web"],
      "`api/` and `worker/`": ["api", "worker"],
      Migrations: ["api", "worker"],
      "docs/manual/": ["docs/manual"],
      "Commit messages": [],
    });
  });
});

describe("guideline selection recall", () => {
  it.each(GUIDELINE_CASES)("gives the review of $name every section it needs", (c) => {
    const given = headings(selectGuidelines(sections, c.files, MAX_GUIDELINES_CHARS).given);
    expect(given).toEqual(expect.arrayContaining(c.needs));
    for (const spared of c.spares) expect(given).not.toContain(spared);
  });

  it("gives fewer characters than the whole document on a scoped change", () => {
    const chars = (files: string[]) =>
      selectGuidelines(sections, files, MAX_GUIDELINES_CHARS)
        .given.map((s) => s.raw)
        .join("\n").length;
    expect(chars(["package.json"])).toBeLessThan(MONOREPO_GUIDELINES.length * 0.6);
  });
});

describe("selectGuidelines", () => {
  it("never cuts a section: one that does not fit is left out whole", () => {
    const budget = sections.slice(0, 2).reduce((n, s) => n + s.raw.length + 1, 0) + 5;
    const { given, left } = selectGuidelines(sections, "all", budget);
    expect(headings(given)).toEqual(["AGENTS.md", "Security"]);
    expect(left).toHaveLength(sections.length - 2);
  });

  it("keeps going past a section too large for what is left", () => {
    const text = `# A\n${"a".repeat(50)}\n# B\n${"b".repeat(500)}\n# C\n${"c".repeat(50)}`;
    const { given } = selectGuidelines(guidelineSections(text), "all", 200);
    expect(headings(given)).toEqual(["A", "C"]);
  });
});

describe("guidelinesForTask", () => {
  it("gives the whole document as written when it fits", () => {
    expect(guidelinesForTask(sections, "all", ["x.ts"], false)).toEqual({
      text: MONOREPO_GUIDELINES,
      left: [],
    });
  });

  it("gives matched sections to reviewers, and every section to the guidelines reviewer", () => {
    const matched = guidelinesForTask(sections, "matched", ["package.json"], false);
    expect(matched?.left).toEqual([
      "`web/`",
      "Components",
      "`api/` and `worker/`",
      "Migrations",
      "docs/manual/",
    ]);
    expect(guidelinesForTask(sections, "matched", ["package.json"], true)?.left).toEqual([]);
  });

  it("gives guidelines only to the guidelines reviewer under the reviewer scope", () => {
    expect(guidelinesForTask(sections, "reviewer", ["a.ts"], false)).toBeUndefined();
    expect(guidelinesForTask(sections, "reviewer", ["a.ts"], true)?.text).toBe(MONOREPO_GUIDELINES);
  });

  it("hands over a first section larger than the budget whole, for the prompt to cut", () => {
    const huge = "x".repeat(MAX_GUIDELINES_CHARS + 10);
    expect(guidelinesForTask(guidelineSections(huge), "all", ["a.ts"], false)?.text).toBe(huge);
  });
});
