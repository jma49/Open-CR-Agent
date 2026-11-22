import { describe, expect, it } from "vitest";
import type { SymbolExtractor } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import type { Learning } from "../knowledge/learning.js";
import { bundleLearnings } from "./learnings.js";

const file: FileDiff = {
  oldPath: "src/db/load.ts",
  newPath: "src/db/load.ts",
  kind: "modified",
  isBinary: false,
  additions: 1,
  deletions: 0,
  hunks: [
    {
      header: "@@",
      oldStart: 2,
      oldLines: 1,
      newStart: 2,
      newLines: 1,
      lines: [{ kind: "add", content: "  const row = q();", newLine: 2 }],
    },
  ],
  patch: "+  const row = q();",
};

const onPath = (id: string, symbols: string[] = []): Learning => ({
  id,
  title: id,
  body: "b",
  paths: ["src/db/**"],
  symbols,
  keywords: [],
  critical: false,
});

function reading() {
  const read: string[] = [];
  const context = {
    readFile: async (path: string) => {
      read.push(path);
      return "function load() {\n  const row = q();\n  client.release();\n}";
    },
    searchCode: async () => [],
  };
  const extractor: SymbolExtractor = {
    symbols: async () => ({
      definitions: [{ name: "load", kind: "function", startLine: 1, endLine: 4 }],
      uses: new Map(),
    }),
  };
  return { read, context, extractor };
}

describe("bundleLearnings", () => {
  it("reads nothing when every candidate fits", async () => {
    const { read, context, extractor } = reading();
    const bundle = { files: [file] };
    const select = await bundleLearnings([onPath("a")], [bundle], context, extractor);
    expect(select(bundle.files).selected.map((l) => l.id)).toEqual(["a"]);
    expect(read).toEqual([]);
  });

  it("ranks a crowded bundle by the code around its change", async () => {
    const { read, context, extractor } = reading();
    const bundle = { files: [file] };
    const crowded = [
      ...Array.from({ length: 8 }, (_, i) => onPath(`a${i}`)),
      onPath("z-release", ["client.release"]),
    ];
    const select = await bundleLearnings(crowded, [bundle], context, extractor);
    expect(select(bundle.files).selected[0]?.id).toBe("z-release");
    expect(read).toEqual(["src/db/load.ts"]);
  });
});
