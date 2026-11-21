import { createHash } from "node:crypto";
import type { FileSymbols, SymbolExtractor } from "@open-cr-agent/core";
import { gitBlobId, type SymbolCache } from "./cache.js";
import { type LanguageSpec, languageOf } from "./languages.js";
import { parseSymbols } from "./parse.js";
import { VERSION } from "./version.js";

// Larger files are generated or data more often than code a change calls.
const MAX_FILE_CHARS = 1_000_000;

export interface TreeSitterOptions {
  // Shared across runs; absent: symbols are kept for this extractor's life.
  cache?: SymbolCache;
}

export function treeSitterSymbols(options: TreeSitterOptions = {}): SymbolExtractor {
  const memo = new Map<string, Promise<FileSymbols | undefined>>();
  return {
    symbols(path, content) {
      const spec = languageOf(path);
      if (!spec || content.length > MAX_FILE_CHARS) return Promise.resolve(undefined);
      const key = cacheKey(spec, content);
      let symbols = memo.get(key);
      if (!symbols) {
        symbols = lookup(spec, content, key, options.cache);
        memo.set(key, symbols);
      }
      return symbols;
    },
  };
}

function cacheKey(spec: LanguageSpec, content: string): string {
  return createHash("sha256")
    .update(`${VERSION}\0${spec.id}\0${gitBlobId(content)}`)
    .digest("hex");
}

async function lookup(
  spec: LanguageSpec,
  content: string,
  key: string,
  cache: SymbolCache | undefined,
): Promise<FileSymbols | undefined> {
  const cached = await cache?.get(key);
  if (cached) return cached;
  const symbols = await parseSymbols(spec, content);
  if (symbols) await cache?.set(key, symbols);
  return symbols;
}
