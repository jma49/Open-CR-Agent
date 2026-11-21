import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReferenceIndex } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { firstReferences, graphFileReferences } from "./references.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const knows = (name: string, path: string): ReferenceIndex => ({
  usesOf: async (_file, symbol) => (symbol === name ? [{ path, line: 1 }] : undefined),
});

describe("firstReferences", () => {
  it("answers from the first index that knows the symbol", async () => {
    const index = firstReferences([knows("a", "scip.ts"), knows("b", "graph.ts")]);
    expect(await index?.usesOf("x.ts", "a")).toEqual([{ path: "scip.ts", line: 1 }]);
    expect(await index?.usesOf("x.ts", "b")).toEqual([{ path: "graph.ts", line: 1 }]);
    expect(await index?.usesOf("x.ts", "c")).toBeUndefined();
    expect(firstReferences([])).toBeUndefined();
  });
});

describe("graphFileReferences", () => {
  it("warns once and answers nothing when the file is not a graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-graph-file-"));
    dirs.push(dir);
    const file = join(dir, "graph.json");
    writeFileSync(file, JSON.stringify({ format: 99 }));
    const warnings: string[] = [];
    const index = graphFileReferences(file, (m) => warnings.push(m));
    expect(await index.usesOf("a.ts", "a")).toBeUndefined();
    expect(await index.usesOf("a.ts", "a")).toBeUndefined();
    expect(warnings).toEqual([
      `code graph ${file} could not be read (not a code graph this version of ocra reads); callers are found by search`,
    ]);
  });
});
