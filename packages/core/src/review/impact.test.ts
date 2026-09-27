import { describe, expect, it } from "vitest";
import type { FileDiff } from "../domain.js";
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

describe("changedSymbols", () => {
  it("finds definitions on changed lines in common languages", () => {
    const files = [
      diff("a.ts", [
        "export async function parseRetries(input: string) {",
        "export const toLimit = (n: number): number => n;",
        "class RetryPolicy {",
      ]),
      diff("b.py", ["def load_config(path):"]),
      diff("c.go", ["func (s *Server) HandleLogin(w http.ResponseWriter) {"]),
    ];
    expect(changedSymbols(files)).toEqual([
      "parseRetries",
      "toLimit",
      "RetryPolicy",
      "load_config",
      "HandleLogin",
    ]);
  });

  it("ignores unchanged lines, short and generic names", () => {
    const files = [
      diff("a.ts", ["function go() {}", "function main() {}"], ["function kept() {}"]),
    ];
    expect(changedSymbols(files)).toEqual([]);
  });
});

describe("findCallers", () => {
  it("lists whole-word uses outside the bundle's own files", async () => {
    const files = [diff("src/retry.ts", ["export function parseRetries(x) {"])];
    const context = {
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
});
