import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileSymbols } from "@open-cr-agent/core";
import { SYMBOL_KINDS } from "@open-cr-agent/core";
import { z } from "zod";

// Symbols keyed by what they were parsed from: a file's git blob id, the
// language it was parsed as and the extractor's version. A key never goes
// stale, so a cache shared across runs, machines or a server needs no
// invalidation.
export interface SymbolCache {
  get(key: string): Promise<FileSymbols | undefined>;
  set(key: string, symbols: FileSymbols): Promise<void>;
}

// Git's object id of a file with this content, so a server that lists a
// tree's blobs can look its files up without reading them. Content that was
// not valid UTF-8 hashes differently from the blob and only misses the cache.
export function gitBlobId(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

const line = z.number().int().positive();
const stored = z.object({
  definitions: z.array(z.tuple([z.string(), z.enum(SYMBOL_KINDS), line, line])),
  uses: z.array(z.tuple([z.string(), z.array(line)])),
});

function serialize(symbols: FileSymbols): string {
  return JSON.stringify({
    definitions: symbols.definitions.map((d) => [d.name, d.kind, d.startLine, d.endLine]),
    uses: [...symbols.uses].map(([name, lines]) => [name, [...lines]]),
  } satisfies z.input<typeof stored>);
}

function deserialize(text: string): FileSymbols | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = stored.safeParse(json);
  if (!parsed.success) return undefined;
  return {
    definitions: parsed.data.definitions.map(([name, kind, startLine, endLine]) => ({
      name,
      kind,
      startLine,
      endLine,
    })),
    uses: new Map(parsed.data.uses),
  };
}

// One JSON file per key under `dir`. Every failure reads as a miss or a
// skipped write: the cache only saves parsing. Writes go through a temporary
// file, so concurrent runs never read half an entry. A hit touches its
// entry, so a cache kept between CI runs can drop what no run read lately
// by modification time.
export function directoryCache(dir: string): SymbolCache {
  const path = (key: string) => join(dir, key.slice(0, 2), `${key}.json`);
  return {
    async get(key) {
      const file = path(key);
      const text = await readFile(file, "utf8").catch(() => undefined);
      const symbols = text === undefined ? undefined : deserialize(text);
      if (symbols) {
        const now = new Date();
        await utimes(file, now, now).catch(() => {});
      }
      return symbols;
    },
    async set(key, symbols) {
      const target = path(key);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        await mkdir(join(dir, key.slice(0, 2)), { recursive: true });
        await writeFile(temporary, serialize(symbols));
        await rename(temporary, target);
      } catch {
        // A full or read-only disk costs only the cache.
        await rm(temporary, { force: true }).catch(() => {});
      }
    },
  };
}
