import { describe, expect, it } from "vitest";
import type { CodeMatch, FileSymbols, SymbolExtractor } from "../contracts.js";
import type { FileDiff, Hunk } from "../domain.js";
import { changedSymbols, findCallers } from "./impact.js";

function diff(path: string, added: string[], context: string[] = []): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: added.length,
    deletions: 0,
    patch: "",
    hunks: [
      {
        header: "@@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          ...context.map((content, i) => ({
            kind: "context" as const,
            content,
            oldLine: i + 1,
            newLine: i + 1,
          })),
          ...added.map((content, i) => ({ kind: "add" as const, content, newLine: i + 10 })),
        ],
      },
    ],
  };
}

const NO_FILES = {
  readFile: async () => undefined,
  searchCode: async (): Promise<CodeMatch[]> => [],
};

function withHunk(path: string, hunk: Hunk): FileDiff {
  return { ...diff(path, []), hunks: [hunk] };
}

function extractor(files: Record<string, FileSymbols>): SymbolExtractor {
  return { symbols: async (path) => files[path] };
}

function repository(files: Record<string, string>) {
  return {
    readFile: async (path: string) => files[path],
    searchCode: async (literal: string) =>
      Object.entries(files).flatMap(([path, content]) =>
        content
          .split("\n")
          .flatMap((text, i) => (text.includes(literal) ? [{ path, line: i + 1, text }] : [])),
      ),
  };
}

describe("changedSymbols without an extractor", () => {
  it("finds definitions on changed lines in common languages", async () => {
    const files = [
      diff("a.ts", [
        "export async function parseRetries(input: string) {",
        "export const toLimit = (n: number): number => n;",
        "class RetryPolicy {",
      ]),
      diff("b.py", ["def load_config(path):"]),
      diff("c.go", ["func (s *Server) HandleLogin(w http.ResponseWriter) {"]),
    ];
    expect(await changedSymbols(files, NO_FILES)).toEqual([
      "parseRetries",
      "toLimit",
      "RetryPolicy",
      "load_config",
      "HandleLogin",
    ]);
  });

  it("ignores unchanged lines, short and generic names", async () => {
    const files = [
      diff("a.ts", ["function go() {}", "function main() {}"], ["function kept() {}"]),
    ];
    expect(await changedSymbols(files, NO_FILES)).toEqual([]);
  });
});

describe("changedSymbols with an extractor", () => {
  const symbols: FileSymbols = {
    definitions: [
      { name: "RetryPolicy", kind: "class", startLine: 1, endLine: 20 },
      { name: "backoff", kind: "method", startLine: 2, endLine: 8 },
      { name: "parseRetries", kind: "method", startLine: 10, endLine: 15 },
    ],
    uses: new Map(),
  };
  const context = { ...NO_FILES, readFile: async () => "content" };

  it("counts a symbol whose body changed, innermost first, signatures before bodies", async () => {
    const file = withHunk("src/retry.ts", {
      header: "@@",
      oldStart: 4,
      oldLines: 1,
      newStart: 4,
      newLines: 1,
      lines: [
        { kind: "context", content: "    const delay = 1;", oldLine: 4, newLine: 4 },
        { kind: "add", content: "    return delay * 2;", newLine: 5 },
        { kind: "add", content: "  parseRetries(input: string, limit = 3) {", newLine: 10 },
        { kind: "add", content: "  // a note between methods", newLine: 18 },
      ],
    });
    expect(await changedSymbols([file], context, extractor({ "src/retry.ts": symbols }))).toEqual([
      "parseRetries",
      "backoff",
      "RetryPolicy",
    ]);
  });

  it("counts the symbol a removal leaves its gap in, and names removed definitions", async () => {
    const file = withHunk("src/retry.ts", {
      header: "@@",
      oldStart: 12,
      oldLines: 3,
      newStart: 12,
      newLines: 1,
      lines: [
        { kind: "context", content: "    const n = 1;", oldLine: 12, newLine: 12 },
        { kind: "delete", content: "    n += legacyLimit();", oldLine: 13 },
        { kind: "delete", content: "  function legacyLimit() {}", oldLine: 14 },
      ],
    });
    expect(await changedSymbols([file], context, extractor({ "src/retry.ts": symbols }))).toEqual([
      "legacyLimit",
      "parseRetries",
    ]);
  });

  it("falls back to definition patterns for a file it does not read", async () => {
    const files = [diff("b.rb", ["def load_config(path)"])];
    expect(await changedSymbols(files, context, extractor({}))).toEqual(["load_config"]);
  });
});

describe("findCallers", () => {
  it("lists whole-word uses outside the bundle's own files without an extractor", async () => {
    const files = [diff("src/retry.ts", ["export function parseRetries(x) {"])];
    const context = {
      readFile: async () => undefined,
      searchCode: async () => [
        { path: "src/retry.ts", line: 3, text: "parseRetries(x)" },
        { path: "src/api.ts", line: 12, text: "const n = parseRetries(header);" },
        { path: "src/other.ts", line: 4, text: "parseRetriesLegacy(x)" },
      ],
    };
    expect(await findCallers(files, context)).toEqual([
      {
        symbol: "parseRetries",
        uses: [{ path: "src/api.ts", line: 12, text: "const n = parseRetries(header);" }],
      },
    ]);
  });

  it("keeps only uses in code, each with the definition it sits in", async () => {
    const files = [diff("src/retry.ts", ["export function parseRetries(x) {"])];
    const context = repository({
      "src/retry.ts": "export function parseRetries(x) {\n}",
      "src/api.ts": [
        "// parseRetries is called below",
        "export function handle(header) {",
        "  return parseRetries(header);",
        "}",
        "const name = 'parseRetries';",
      ].join("\n"),
    });
    const symbols = extractor({
      "src/retry.ts": {
        definitions: [{ name: "parseRetries", kind: "function", startLine: 10, endLine: 12 }],
        uses: new Map(),
      },
      "src/api.ts": {
        definitions: [{ name: "handle", kind: "function", startLine: 2, endLine: 4 }],
        uses: new Map([["parseRetries", [3]]]),
      },
    });
    expect(await findCallers(files, context, symbols)).toEqual([
      {
        symbol: "parseRetries",
        uses: [
          { path: "src/api.ts", line: 3, text: "  return parseRetries(header);", within: "handle" },
        ],
      },
    ]);
  });
});
