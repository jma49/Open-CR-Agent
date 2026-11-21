import type { FileSymbols } from "@open-cr-agent/core";
import { SYMBOL_KINDS } from "@open-cr-agent/core";
import { z } from "zod";

// A file's symbols as the cache and the graph keep them: tuples, so a
// repository's worth stays small.
const line = z.number().int().positive();
export const storedSymbols = z.object({
  definitions: z.array(z.tuple([z.string(), z.enum(SYMBOL_KINDS), line, line])),
  uses: z.array(z.tuple([z.string(), z.array(line)])),
});
export type StoredSymbols = z.infer<typeof storedSymbols>;

export function toStored(symbols: FileSymbols): StoredSymbols {
  return {
    definitions: symbols.definitions.map((d) => [d.name, d.kind, d.startLine, d.endLine]),
    uses: [...symbols.uses].map(([name, lines]) => [name, [...lines]]),
  };
}

export function fromStored(stored: StoredSymbols): FileSymbols {
  return {
    definitions: stored.definitions.map(([name, kind, startLine, endLine]) => ({
      name,
      kind,
      startLine,
      endLine,
    })),
    uses: new Map(stored.uses),
  };
}
