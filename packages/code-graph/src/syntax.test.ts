import { describe, expect, it } from "vitest";
import { languageOf } from "./languages.js";
import { parseErrors } from "./parse.js";
import { treeSitterSyntax } from "./syntax.js";

describe("treeSitterSyntax", () => {
  const syntax = treeSitterSyntax();

  it("finds no error in valid code", async () => {
    expect(
      await syntax.errors("a.ts", "export function f(n: number) {\n  return n + 1;\n}\n"),
    ).toBe(0);
    expect(await syntax.errors("a.py", "def f(n):\n    return n + 1\n")).toBe(0);
  });

  it("counts errors and missing tokens", async () => {
    expect(
      await syntax.errors("a.ts", "export function f(n: number) {\n  return n +;\n"),
    ).toBeGreaterThan(0);
    expect(await syntax.errors("a.go", "package a\nfunc f() {\n")).toBeGreaterThan(0);
  });

  it("does not know a language it has no grammar for", async () => {
    expect(await syntax.errors("notes.md", "# title\n")).toBeUndefined();
  });

  it("gives up on a file it cannot parse within its budget", async () => {
    const spec = languageOf("data.ts");
    if (!spec) throw new Error("no TypeScript");
    const content = `export const a = [${"1,".repeat(200_000)}];\n`;
    expect(await parseErrors(spec, content, 0)).toBeUndefined();
    expect(await parseErrors(spec, "export const b = 2;\n")).toBe(0);
  });
});
