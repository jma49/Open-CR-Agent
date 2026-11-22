import { describe, expect, it } from "vitest";
import { docSections, PROJECT_DOC_LIMITS, projectDocUses, sectionsFor } from "./project-docs.js";

const doc = (text: string, path = "docs/design.md") => ({ path, text });

describe("docSections", () => {
  it("splits at headings of level 1 to 3, never inside a code fence", () => {
    const sections = docSections([
      doc(
        "intro\n# Auth\nTokens.\n```md\n# not a heading\n```\n#### Detail\nmore\n## Billing\nInvoices.",
      ),
    ]);
    expect(sections.map((s) => s.heading)).toEqual(["docs/design.md", "Auth", "Billing"]);
    expect(sections[1]?.text).toContain("# not a heading");
    expect(sections[1]?.text).toContain("#### Detail");
  });

  it("drops sections with no text and numbers them across documents", () => {
    const sections = docSections([doc("# Empty\n\n# Full\nx"), doc("# Other\ny", "b.md")]);
    expect(sections.map((s) => [s.heading, s.order])).toEqual([
      ["Full", 0],
      ["Other", 1],
    ]);
  });
});

describe("sectionsFor", () => {
  const sections = docSections([
    doc(
      [
        "# Overview",
        "The service lives in services/payments and talks to the bank.",
        "# Tokens",
        "packages/auth/src/token.ts refuses expired tokens.",
        "# Names only",
        "token.ts must stay pure.",
        "# Unrelated",
        "Nothing here names a file; tokenizer.ts is another file.",
      ].join("\n"),
    ),
  ]);

  it("ranks a section that names the path above one that names the file or directory", () => {
    const { given } = sectionsFor(sections, ["packages/auth/src/token.ts"]);
    expect(given.map((s) => s.heading)).toEqual(["Tokens", "Names only"]);
  });

  it("matches a directory a section names, but not a longer name that contains the file's", () => {
    expect(
      sectionsFor(sections, ["services/payments/charge.go"]).given.map((s) => s.heading),
    ).toEqual(["Overview"]);
    expect(sectionsFor(sections, ["src/izer.ts"]).given).toEqual([]);
  });

  it("gives at most the limit and lists the rest", () => {
    const many = docSections([
      doc(Array.from({ length: 6 }, (_, i) => `# S${i}\nsrc/app/main.ts`).join("\n")),
    ]);
    const { given, more } = sectionsFor(many, ["src/app/main.ts"]);
    expect(given).toHaveLength(PROJECT_DOC_LIMITS.given);
    expect(more.map((s) => s.heading)).toEqual(["S3", "S4", "S5"]);
  });
});

describe("projectDocUses", () => {
  it("lists each section given with the bundles it was given to", () => {
    const sections = docSections([doc("# A\nsrc/a.ts\n# B\nsrc/b.ts")]);
    expect(
      projectDocUses(sections, [
        { label: "b", files: ["src/b.ts"] },
        { label: "both", files: ["src/a.ts", "src/b.ts"] },
      ]),
    ).toEqual([
      { path: "docs/design.md", heading: "A", bundles: ["both"] },
      { path: "docs/design.md", heading: "B", bundles: ["b", "both"] },
    ]);
  });
});
