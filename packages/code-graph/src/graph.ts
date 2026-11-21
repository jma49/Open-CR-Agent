import type { FileSymbols, ReferenceIndex, SymbolReference } from "@open-cr-agent/core";
import { mapWithConcurrency } from "@open-cr-agent/core/internal";
import { z } from "zod";
import { languageOf } from "./languages.js";
import { parseSymbols } from "./parse.js";
import { fromStored, type StoredSymbols, storedSymbols, toStored } from "./stored.js";
import { VERSION } from "./version.js";

// The symbols of every file of one revision, keyed by what they were parsed
// from (language and git blob id), so the next revision's graph reuses each
// file it did not change. It holds names, kinds and line numbers, never
// code.
export interface CodeGraph {
  // The parser that made the symbols: another one's are parsed again.
  parser: string;
  revision?: string;
  // path → the key of its symbols
  files: ReadonlyMap<string, string>;
  symbols: ReadonlyMap<string, FileSymbols>;
}

// A file of the revision, as `git ls-tree -l` or a platform's tree API
// lists it; the host assembles the whole list and reports truncation.
export interface TreeEntry {
  path: string;
  blobId: string;
  size?: number;
}

type SkipReason = "too-large" | "unreadable" | "not-text" | "unparsed" | "over-limit";

export interface UpdateOptions {
  revision?: string;
  // Reads in flight at once; readBlob is often a network call.
  concurrency?: number;
  signal?: AbortSignal;
  maxFiles?: number;
  maxBlobBytes?: number;
}

export interface GraphUpdate {
  graph: CodeGraph;
  parsed: number;
  reused: number;
  skipped: { path: string; reason: SkipReason }[];
}

export type ReadBlob = (blobId: string, path: string) => Promise<Uint8Array | undefined>;

const DEFAULTS = { concurrency: 8, maxFiles: 100_000, maxBlobBytes: 1_000_000 };

// Parses only the files whose key `previous` lacks. A file that cannot be
// read or parsed is skipped and recorded, never fatal, and tried again on
// the next update.
export async function updateGraph(
  previous: CodeGraph | undefined,
  tree: readonly TreeEntry[],
  readBlob: ReadBlob,
  options: UpdateOptions = {},
): Promise<GraphUpdate> {
  const { concurrency, maxFiles, maxBlobBytes } = { ...DEFAULTS, ...options };
  const reusable = previous?.parser === VERSION ? previous.symbols : new Map();
  const files = new Map<string, string>();
  const symbols = new Map<string, FileSymbols>();
  const skipped: GraphUpdate["skipped"] = [];
  const toParse = new Map<string, TreeEntry>();
  const sorted = [...tree].sort((a, b) => compare(a.path, b.path));
  for (const entry of sorted) {
    const spec = languageOf(entry.path);
    if (!spec) continue;
    if (files.size >= maxFiles) {
      skipped.push({ path: entry.path, reason: "over-limit" });
      continue;
    }
    const key = `${spec.id}:${entry.blobId}`;
    files.set(entry.path, key);
    const known = reusable.get(key);
    if (known) symbols.set(key, known);
    else if (!toParse.has(key)) toParse.set(key, entry);
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (bytes: Uint8Array): string | undefined => {
    try {
      return decoder.decode(bytes);
    } catch {
      return undefined;
    }
  };
  const outcomes = await mapWithConcurrency([...toParse], concurrency, async ([key, entry]) => {
    options.signal?.throwIfAborted();
    const outcome = await parseEntry(entry, readBlob, decode, maxBlobBytes);
    if (typeof outcome !== "string") symbols.set(key, outcome);
    return outcome;
  });
  options.signal?.throwIfAborted();
  const failed = new Map<string, SkipReason>();
  [...toParse.keys()].forEach((key, i) => {
    const outcome = outcomes[i];
    if (typeof outcome === "string") failed.set(key, outcome);
  });
  for (const [path, key] of files) {
    const reason = failed.get(key);
    if (!reason) continue;
    files.delete(path);
    skipped.push({ path, reason });
  }
  skipped.sort((a, b) => compare(a.path, b.path));
  return {
    graph: { parser: VERSION, ...optional("revision", options.revision), files, symbols },
    parsed: toParse.size - failed.size,
    reused: symbols.size - (toParse.size - failed.size),
    skipped,
  };
}

async function parseEntry(
  entry: TreeEntry,
  readBlob: ReadBlob,
  decode: (bytes: Uint8Array) => string | undefined,
  maxBlobBytes: number,
): Promise<FileSymbols | SkipReason> {
  if (entry.size !== undefined && entry.size > maxBlobBytes) return "too-large";
  const bytes = await readBlob(entry.blobId, entry.path).catch(() => undefined);
  if (!bytes) return "unreadable";
  if (bytes.byteLength > maxBlobBytes) return "too-large";
  const content = decode(bytes);
  if (content === undefined) return "not-text";
  const spec = languageOf(entry.path);
  const symbols = spec && (await parseSymbols(spec, content));
  return symbols ?? "unparsed";
}

// Callers by name across the revision the graph describes: matched, not
// resolved. Undefined when the graph does not know `path` defines `name`,
// so the review searches instead.
export function graphReferences(graph: CodeGraph): ReferenceIndex {
  return {
    async usesOf(path, name) {
      const own = graph.symbols.get(graph.files.get(path) ?? "");
      if (!own?.definitions.some((d) => d.name === name)) return undefined;
      const uses: SymbolReference[] = [];
      for (const [file, key] of graph.files) {
        if (file === path) continue;
        for (const line of graph.symbols.get(key)?.uses.get(name) ?? []) {
          uses.push({ path: file, line });
        }
      }
      return uses;
    },
  };
}

const GRAPH_FORMAT = 1;

const graphSchema = z.object({
  format: z.literal(GRAPH_FORMAT),
  parser: z.string(),
  revision: z.string().optional(),
  files: z.array(z.tuple([z.string(), z.string()])),
  symbols: z.array(z.tuple([z.string(), storedSymbols])),
});

// Deterministic: the same graph always serializes to the same text, so
// stored graphs dedupe and diff.
export function serializeGraph(graph: CodeGraph): string {
  const files = [...graph.files].sort(([a], [b]) => compare(a, b));
  const used = new Set(files.map(([, key]) => key));
  const symbols = [...graph.symbols]
    .filter(([key]) => used.has(key))
    .sort(([a], [b]) => compare(a, b))
    .map(([key, s]): [string, StoredSymbols] => [key, toStored(s)]);
  return JSON.stringify({
    format: GRAPH_FORMAT,
    parser: graph.parser,
    ...optional("revision", graph.revision),
    files,
    symbols,
  } satisfies z.input<typeof graphSchema>);
}

// Undefined for text that is not a graph of a format this version reads.
export function parseGraph(text: string): CodeGraph | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = graphSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const { parser, revision, files, symbols } = parsed.data;
  return {
    parser,
    ...optional("revision", revision),
    files: new Map(files),
    symbols: new Map(symbols.map(([key, s]) => [key, fromStored(s)])),
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}
