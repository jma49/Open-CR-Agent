import type {
  FileSymbols,
  ReviewContext,
  SymbolDefinition,
  SymbolExtractor,
} from "../contracts.js";
import type { FileDiff } from "../domain.js";

// Impact analysis (--ultra and the full tier): the symbols a bundle defines
// or changes, and where the rest of the repository uses them, so reviewers
// see the callers a change can break without spending their own steps to
// find them. With a SymbolExtractor a symbol counts as changed when any line
// of its body is, and a use is an identifier in code, with the definition it
// sits in; without one, or for a language it does not read, definition
// patterns on changed lines and whole-word search stand in. A miss only
// costs that hint, never a finding.
const MAX_SYMBOLS = 8;
const MAX_CALLERS_PER_SYMBOL = 10;
// Files read per symbol: each is a read and a parse, and a common name
// matches comments and strings in many.
const MAX_FILES_PER_SYMBOL = 20;

const DEFINITIONS = [
  // function f, def f, func f, func (r T) f, fn f, class C, interface I,
  // type T, struct S, enum E, trait T
  /\b(?:function\*?|def|func|fn|class|interface|type|struct|enum|trait)\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)/g,
  // const f = (…) => / const f = function / const f = async (…) =>
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/g,
];
const IGNORED = new Set(["constructor", "main", "init", "new", "get", "set", "test", "type"]);

export type ImpactContext = Pick<ReviewContext, "readFile" | "searchCode">;

interface CallerSite {
  path: string;
  line: number;
  text: string;
  // The definition the use sits in, when the extractor read its file.
  within?: string;
}

export interface SymbolUse {
  symbol: string;
  uses: CallerSite[];
}

// A changed signature breaks callers more often than a changed body, so
// those names come first when the cap cuts the list.
export async function changedSymbols(
  files: readonly FileDiff[],
  context: ImpactContext,
  extractor?: SymbolExtractor,
): Promise<string[]> {
  const signatures: string[] = [];
  const bodies: string[] = [];
  for (const file of files) {
    for (const line of file.hunks.flatMap((h) => h.lines)) {
      if (line.kind === "delete") signatures.push(...definedOn(line.content));
    }
    const symbols =
      file.kind === "deleted" ? undefined : await read(file.newPath, context, extractor);
    if (!symbols) {
      for (const line of file.hunks.flatMap((h) => h.lines)) {
        if (line.kind === "add") signatures.push(...definedOn(line.content));
      }
      continue;
    }
    for (const line of touchedLines(file)) {
      const definition = innermost(symbols.definitions, line);
      if (definition) (line === definition.startLine ? signatures : bodies).push(definition.name);
    }
  }
  return [...new Set([...signatures, ...bodies])]
    .filter((name) => name.length >= 3 && !IGNORED.has(name.toLowerCase()))
    .slice(0, MAX_SYMBOLS);
}

// Uses outside the bundle's own files: inside them the reviewer already sees
// the code.
export async function findCallers(
  files: readonly FileDiff[],
  context: ImpactContext,
  extractor?: SymbolExtractor,
): Promise<SymbolUse[]> {
  const own = new Set(files.map((f) => f.newPath));
  const result: SymbolUse[] = [];
  for (const symbol of await changedSymbols(files, context, extractor)) {
    const matches = await context.searchCode(symbol).catch(() => []);
    const uses: CallerSite[] = [];
    const paths = [...new Set(matches.map((m) => m.path))].filter((p) => !own.has(p));
    for (const path of paths.slice(0, MAX_FILES_PER_SYMBOL)) {
      const symbols = await read(path, context, extractor);
      const found = symbols
        ? await usesIn(path, symbol, symbols, context)
        : matches.filter((m) => m.path === path && wholeWord(symbol).test(m.text));
      uses.push(...found);
      if (uses.length >= MAX_CALLERS_PER_SYMBOL) break;
    }
    if (uses.length > 0) result.push({ symbol, uses: uses.slice(0, MAX_CALLERS_PER_SYMBOL) });
  }
  return result;
}

async function read(
  path: string,
  context: ImpactContext,
  extractor: SymbolExtractor | undefined,
): Promise<FileSymbols | undefined> {
  if (!extractor) return undefined;
  const content = await context.readFile(path).catch(() => undefined);
  return content === undefined
    ? undefined
    : extractor.symbols(path, content).catch(() => undefined);
}

async function usesIn(
  path: string,
  symbol: string,
  symbols: FileSymbols,
  context: ImpactContext,
): Promise<CallerSite[]> {
  const lines = symbols.uses.get(symbol) ?? [];
  if (lines.length === 0) return [];
  const text = ((await context.readFile(path).catch(() => undefined)) ?? "").split("\n");
  return lines.map((line) => {
    const within = innermost(symbols.definitions, line)?.name;
    return { path, line, text: text[line - 1] ?? "", ...(within ? { within } : {}) };
  });
}

// New-side lines a hunk adds, and the line a removal leaves its gap before.
function touchedLines(file: FileDiff): number[] {
  const lines: number[] = [];
  for (const hunk of file.hunks) {
    let next = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === "delete") {
        lines.push(next);
        continue;
      }
      next = (line.newLine ?? next) + 1;
      if (line.kind === "add" && line.newLine !== undefined) lines.push(line.newLine);
    }
  }
  return lines;
}

function innermost(
  definitions: readonly SymbolDefinition[],
  line: number,
): SymbolDefinition | undefined {
  let best: SymbolDefinition | undefined;
  for (const d of definitions) {
    if (line < d.startLine || line > d.endLine) continue;
    if (!best || d.endLine - d.startLine < best.endLine - best.startLine) best = d;
  }
  return best;
}

function definedOn(content: string): string[] {
  return DEFINITIONS.flatMap((pattern) =>
    [...content.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : [])),
  );
}

function wholeWord(symbol: string): RegExp {
  return new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}
