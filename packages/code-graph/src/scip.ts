import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { errorMessage, type ReferenceIndex, type SymbolReference } from "@open-cr-agent/core";
import { type Document, IndexSchema, type Occurrence, SymbolRole } from "@scip-code/scip";

// Larger indexes would not fit in memory once decoded.
const MAX_INDEX_BYTES = 512 * 1024 * 1024;

export interface ScipOptions {
  // Called once if the index cannot be read; reviews then search instead.
  warn?: (message: string) => void;
}

interface Loaded {
  // path → name → the SCIP symbols the file defines under that name
  definitions: Map<string, Map<string, string[]>>;
  uses: Map<string, SymbolReference[]>;
}

// A SCIP index (scip-typescript, scip-java, scip-python, …) built at the
// repository root, read once on first use. Its positions are those of the
// revision it was built from; callers check each line still names the
// symbol.
export function scipReferences(file: string, options: ScipOptions = {}): ReferenceIndex {
  let loaded: Promise<Loaded | undefined> | undefined;
  return {
    async usesOf(path, name) {
      loaded ??= load(file).catch((error: unknown) => {
        options.warn?.(
          `SCIP index ${file} could not be read (${errorMessage(error)}); callers are found by search`,
        );
        return undefined;
      });
      const index = await loaded;
      const symbols = index?.definitions.get(path)?.get(name);
      if (!index || !symbols) return undefined;
      const seen = new Set<string>();
      return symbols
        .flatMap((symbol) => index.uses.get(symbol) ?? [])
        .filter((use) => {
          const key = `${use.path}:${use.line}`;
          if (use.path === path || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },
  };
}

async function load(file: string): Promise<Loaded> {
  const { size } = await stat(file);
  if (size > MAX_INDEX_BYTES) throw new Error(`${size} bytes, more than ${MAX_INDEX_BYTES}`);
  const index = fromBinary(IndexSchema, await readFile(file));
  const loaded: Loaded = { definitions: new Map(), uses: new Map() };
  for (const document of index.documents) addDocument(loaded, document);
  return loaded;
}

function addDocument(loaded: Loaded, document: Document): void {
  const path = posix.normalize(document.relativePath.replaceAll("\\", "/"));
  const displayNames = new Map(
    document.symbols.filter((s) => s.displayName).map((s) => [s.symbol, s.displayName]),
  );
  for (const occurrence of document.occurrences) {
    const { symbol } = occurrence;
    if (symbol === "" || symbol.startsWith("local ")) continue;
    if (occurrence.symbolRoles & SymbolRole.Definition) {
      const name = displayNames.get(symbol) ?? symbolName(symbol);
      if (!name) continue;
      const names = loaded.definitions.get(path) ?? new Map<string, string[]>();
      names.set(name, [...(names.get(name) ?? []), symbol]);
      loaded.definitions.set(path, names);
      continue;
    }
    const uses = loaded.uses.get(symbol) ?? [];
    uses.push({ path, line: startLine(occurrence) + 1 });
    loaded.uses.set(symbol, uses);
  }
}

function startLine(occurrence: Occurrence): number {
  const { typedRange, range } = occurrence;
  if (typedRange.case === "singleLineRange") return typedRange.value.line;
  if (typedRange.case === "multiLineRange") return typedRange.value.startLine;
  return range[0] ?? 0;
}

// The name of a symbol's last descriptor (SCIP's symbol grammar): `Retry#`,
// `parse().`, `limit.` or a backquoted name; undefined when the symbol ends
// in a parameter or type parameter, which nothing outside calls.
export function symbolName(symbol: string): string | undefined {
  const descriptors = afterFields(symbol, 4);
  if (descriptors === undefined) return undefined;
  let last: string | undefined;
  let i = 0;
  while (i < descriptors.length) {
    const opening = descriptors[i];
    if (opening === "(" || opening === "[") {
      const close = descriptors.indexOf(opening === "(" ? ")" : "]", i);
      if (close < 0) return undefined;
      last = undefined;
      i = close + 1;
      continue;
    }
    const [name, next] = readName(descriptors, i);
    if (name === undefined) return undefined;
    i = next;
    if (descriptors[i] === "(") {
      const close = descriptors.indexOf(")", i);
      if (close < 0) return undefined;
      i = close + 1;
    }
    if (!"/#.:!".includes(descriptors[i] ?? "")) return undefined;
    last = name;
    i += 1;
  }
  return last;
}

// The rest of the symbol after `count` space-separated fields, where a
// field's own space is written twice.
function afterFields(symbol: string, count: number): string | undefined {
  let i = 0;
  for (let field = 0; field < count; field++) {
    for (;;) {
      const space = symbol.indexOf(" ", i);
      if (space < 0) return undefined;
      if (symbol[space + 1] === " ") {
        i = space + 2;
        continue;
      }
      i = space + 1;
      break;
    }
  }
  return symbol.slice(i);
}

function readName(text: string, start: number): [string | undefined, number] {
  if (text[start] === "`") {
    let name = "";
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "`") {
        if (text[i + 1] !== "`") return [name, i + 1];
        name += "`";
        i += 2;
        continue;
      }
      name += text[i];
      i += 1;
    }
    return [undefined, i];
  }
  const match = /^[\w+$-]+/.exec(text.slice(start));
  return match ? [match[0], start + match[0].length] : [undefined, start];
}
