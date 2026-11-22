import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { FileSymbols, SymbolDefinition, SymbolKind } from "@open-cr-agent/core";
import { SYMBOL_KINDS } from "@open-cr-agent/core";
import type * as TreeSitter from "@vscode/tree-sitter-wasm";
import type { LanguageSpec } from "./languages.js";

// The package is a UMD bundle, which Node's ESM loader cannot read named
// exports from.
const require = createRequire(import.meta.url);
const GRAMMARS = dirname(require.resolve("@vscode/tree-sitter-wasm"));

// A parse and its queries that take longer give up: the file goes without
// symbols, and nothing is cached, rather than hold the review on hostile or
// pathological input.
const PARSE_BUDGET_MS = 1_000;

// When two patterns match one node (a Go struct is also a type spec), the
// more specific kind wins.
const KIND_RANK: readonly SymbolKind[] = [
  "class",
  "interface",
  "enum",
  "method",
  "function",
  "type",
  "module",
  "variable",
];

interface Loaded {
  parser: TreeSitter.Parser;
  definitions: TreeSitter.Query;
  uses: TreeSitter.Query;
}

let runtime: Promise<typeof TreeSitter> | undefined;
const languages = new Map<string, Promise<Loaded>>();

function treeSitter(): Promise<typeof TreeSitter> {
  runtime ??= (async () => {
    const module = require("@vscode/tree-sitter-wasm") as typeof TreeSitter;
    await module.Parser.init({ locateFile: (file) => join(GRAMMARS, file) });
    return module;
  })();
  return runtime;
}

function load(spec: LanguageSpec): Promise<Loaded> {
  let loaded = languages.get(spec.id);
  if (!loaded) {
    loaded = (async () => {
      const { Language, Parser, Query } = await treeSitter();
      const language = await Language.load(join(GRAMMARS, spec.grammar));
      const parser = new Parser();
      parser.setLanguage(language);
      return {
        parser,
        definitions: new Query(language, spec.definitions),
        uses: new Query(language, spec.uses),
      };
    })();
    languages.set(spec.id, loaded);
  }
  return loaded;
}

// A parse cancelled by its budget leaves the parser holding it, and the next
// parse would resume it on another file's text: reset it.
function parseWithin(parser: TreeSitter.Parser, content: string, budgetMs: number) {
  const deadline = performance.now() + budgetMs;
  let late = false;
  const progressCallback = () => {
    late ||= performance.now() > deadline;
    return late;
  };
  const tree = parser.parse(content, null, { progressCallback });
  if (!tree) parser.reset();
  return { tree, progressCallback, late: () => late };
}

export async function parseSymbols(
  spec: LanguageSpec,
  content: string,
  budgetMs = PARSE_BUDGET_MS,
): Promise<FileSymbols | undefined> {
  const { parser, definitions, uses } = await load(spec);
  const { tree, progressCallback, late } = parseWithin(parser, content, budgetMs);
  if (!tree) return undefined;
  try {
    const matches = definitions.matches(tree.rootNode, { progressCallback });
    const captures = uses.captures(tree.rootNode, { progressCallback });
    if (late()) return undefined;
    const found = collectDefinitions(matches);
    const nameStarts = new Set(found.map((d) => d.nameStart));
    const lines = new Map<string, Set<number>>();
    for (const { node } of captures) {
      if (nameStarts.has(node.startIndex)) continue;
      const seen = lines.get(node.text) ?? new Set<number>();
      seen.add(node.startPosition.row + 1);
      lines.set(node.text, seen);
    }
    return {
      definitions: asMethods(found.map(({ nameStart: _, ...definition }) => definition)),
      uses: new Map([...lines].map(([name, rows]) => [name, [...rows].sort((a, b) => a - b)])),
    };
  } finally {
    tree.delete();
  }
}

// How many error and missing nodes the parser had to insert; undefined when
// the parse ran out of time.
export async function parseErrors(
  spec: LanguageSpec,
  content: string,
  budgetMs = PARSE_BUDGET_MS,
): Promise<number | undefined> {
  const { parser } = await load(spec);
  const { tree } = parseWithin(parser, content, budgetMs);
  if (!tree) return undefined;
  try {
    let errors = 0;
    const pending: TreeSitter.Node[] = [tree.rootNode];
    for (let node = pending.pop(); node; node = pending.pop()) {
      if (node.isError || node.isMissing) errors += 1;
      for (const child of node.children)
        if (child?.hasError || child?.isMissing) pending.push(child);
    }
    return errors;
  } finally {
    tree.delete();
  }
}

interface Found extends SymbolDefinition {
  nameStart: number;
}

function collectDefinitions(matches: readonly TreeSitter.QueryMatch[]): Found[] {
  const byNode = new Map<number, Found>();
  for (const { captures } of matches) {
    const name = captures.find((c) => c.name === "name")?.node;
    const definition = captures.find((c) => c.name.startsWith("definition."));
    if (!name || !definition) continue;
    const kind = definition.name.slice("definition.".length) as SymbolKind;
    if (!SYMBOL_KINDS.includes(kind)) continue;
    const id = definition.node.startIndex;
    const previous = byNode.get(id);
    if (previous && KIND_RANK.indexOf(previous.kind) <= KIND_RANK.indexOf(kind)) continue;
    byNode.set(id, {
      name: name.text,
      kind,
      startLine: definition.node.startPosition.row + 1,
      endLine: definition.node.endPosition.row + 1,
      nameStart: name.startIndex,
    });
  }
  return [...byNode.values()].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
}

// A function defined inside a class or interface is its method, whatever the
// grammar calls it (Python has only function definitions).
function asMethods(definitions: SymbolDefinition[]): SymbolDefinition[] {
  return definitions.map((definition) => {
    if (definition.kind !== "function") return definition;
    const owner = innermostAround(definitions, definition);
    return owner && (owner.kind === "class" || owner.kind === "interface")
      ? { ...definition, kind: "method" }
      : definition;
  });
}

function innermostAround(
  definitions: readonly SymbolDefinition[],
  inner: SymbolDefinition,
): SymbolDefinition | undefined {
  let best: SymbolDefinition | undefined;
  for (const d of definitions) {
    if (d === inner || d.startLine > inner.startLine || d.endLine < inner.endLine) continue;
    if (!best || d.endLine - d.startLine < best.endLine - best.startLine) best = d;
  }
  return best;
}
