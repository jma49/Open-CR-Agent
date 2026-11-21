import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrustedTree } from "../review/target.js";
import { documentCandidates, sectionsOf } from "./documents.js";

const doc = `# Payments postmortem

Background on the outage.

## Amounts are integer cents

Never use \`parseFloat\` on an amount in src/money/amount.ts; convert with toCents().

\`\`\`md
## not a heading inside a fence
\`\`\`

## Amounts are integer cents

Same heading again, naming ./src/money/missing.ts only.
`;

const tree: TrustedTree = {
  readFile: async (path) =>
    path === "src/money/amount.ts"
      ? "export const toCents = (s) => Math.round(+s * 100);\n"
      : undefined,
  listFiles: async () => [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("sectionsOf", () => {
  it("splits at ## headings outside code fences, the introduction under the title", () => {
    expect(sectionsOf(doc).map((s) => [s.heading, s.slug])).toEqual([
      ["Payments postmortem", "payments-postmortem"],
      ["Amounts are integer cents", "amounts-are-integer-cents"],
      ["Amounts are integer cents", "amounts-are-integer-cents-2"],
    ]);
    expect(sectionsOf(doc)[1]?.text).toContain("## not a heading inside a fence");
  });
});

describe("documentCandidates", () => {
  it("gives each section with the repository files it names, by document and section", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-docs-"));
    dirs.push(root);
    writeFileSync(join(root, "postmortem.md"), doc);
    const candidates = await documentCandidates(root, [join(root, "postmortem.md")], tree);
    expect(candidates.map((c) => c.ref)).toEqual([
      "postmortem.md#payments-postmortem",
      "postmortem.md#amounts-are-integer-cents",
      "postmortem.md#amounts-are-integer-cents-2",
    ]);
    const evidence = await candidates[1]?.evidence();
    expect(evidence).toMatchObject({
      kind: "document",
      source: { kind: "document", ref: "postmortem.md#amounts-are-integer-cents" },
      subject: "Amounts are integer cents",
    });
    expect(evidence?.files.map((f) => f.newPath)).toEqual(["src/money/amount.ts"]);
    expect(evidence?.files[0]?.patch).toBe(
      " export const toCents = (s) => Math.round(+s * 100);\n ",
    );
    expect((await candidates[2]?.evidence())?.files).toEqual([]);
  });

  it("refuses a document past its size", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-docs-"));
    dirs.push(root);
    writeFileSync(join(root, "big.md"), "x".repeat(300 * 1024));
    await expect(documentCandidates(root, [join(root, "big.md")], tree)).rejects.toThrow(
      "larger than",
    );
  });
});
