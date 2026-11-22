import { join } from "node:path";
import { directoryCache, treeSitterSymbols } from "@open-cr-agent/code-graph";
import type { SymbolExtractor } from "@open-cr-agent/core";
import { ocraCacheDir } from "../../config/user-dir.js";

// One extractor for a review and its --plan, so the plan shows the
// learnings the run will give.
export function reviewSymbols(env: Readonly<Record<string, string | undefined>>): SymbolExtractor {
  return treeSitterSymbols({ cache: directoryCache(join(ocraCacheDir(env), "symbols")) });
}
