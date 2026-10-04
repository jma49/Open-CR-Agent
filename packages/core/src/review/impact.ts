import type { CodeMatch, ReviewContext } from "../contracts.js";
import type { FileDiff } from "../domain.js";

// --ultra's impact analysis: the symbols a bundle defines or changes, and
// where the rest of the repository uses them, so reviewers see the callers a
// change can break without spending their own steps to find them. Symbols
// are found by definition patterns common to the languages we review; a miss
// only costs that hint, never a finding.
const MAX_SYMBOLS = 8;
const MAX_CALLERS_PER_SYMBOL = 10;

const DEFINITIONS = [
  // function f, def f, func f, func (r T) f, fn f, class C, interface I,
  // type T, struct S, enum E, trait T
  /\b(?:function\*?|def|func|fn|class|interface|type|struct|enum|trait)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/g,
  // const f = (…) => / const f = function / const f = async (…) =>
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
];
const IGNORED = new Set(["constructor", "main", "init", "new", "get", "set", "test", "type"]);

export function changedSymbols(files: readonly FileDiff[]): string[] {
  const symbols = new Set<string>();
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        if (line.kind === "context") continue;
        for (const pattern of DEFINITIONS) {
          for (const match of line.content.matchAll(pattern)) {
            const name = match[1];
            if (name && name.length >= 3 && !IGNORED.has(name.toLowerCase())) symbols.add(name);
          }
        }
      }
    }
  }
  return [...symbols].slice(0, MAX_SYMBOLS);
}

export interface SymbolUse {
  symbol: string;
  uses: CodeMatch[];
}

// Uses outside the bundle's own files: inside them the reviewer already sees
// the code.
export async function findCallers(
  files: readonly FileDiff[],
  context: Pick<ReviewContext, "searchCode">,
): Promise<SymbolUse[]> {
  const own = new Set(files.map((f) => f.newPath));
  const result: SymbolUse[] = [];
  for (const symbol of changedSymbols(files)) {
    const matches = await context.searchCode(symbol).catch(() => []);
    const uses = matches
      .filter((m) => !own.has(m.path) && new RegExp(`\\b${escapeRegExp(symbol)}\\b`).test(m.text))
      .slice(0, MAX_CALLERS_PER_SYMBOL);
    if (uses.length > 0) result.push({ symbol, uses });
  }
  return result;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
