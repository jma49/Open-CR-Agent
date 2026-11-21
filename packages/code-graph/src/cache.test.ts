import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSymbols } from "@open-cr-agent/core";
import { afterEach, describe, expect, it } from "vitest";
import { directoryCache, gitBlobId } from "./cache.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-symbols-"));
  dirs.push(dir);
  return dir;
}

const KEY = "ab".repeat(32);
const SYMBOLS: FileSymbols = {
  definitions: [{ name: "parse", kind: "function", startLine: 2, endLine: 9 }],
  uses: new Map([
    ["helper", [3, 7]],
    ["__proto__", [4]],
  ]),
};

describe("gitBlobId", () => {
  it("is the id git gives the same content", () => {
    // printf 'hello\n' | git hash-object --stdin
    expect(gitBlobId("hello\n")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    // A character counts as its UTF-8 bytes, as for git.
    expect(gitBlobId("é\n")).toBe("c6003325155f475bd7c87731607525dce73be9cf");
  });
});

describe("directoryCache", () => {
  it("returns what was stored, across instances", async () => {
    const dir = scratch();
    await directoryCache(dir).set(KEY, SYMBOLS);
    expect(await directoryCache(dir).get(KEY)).toEqual(SYMBOLS);
    expect(readdirSync(join(dir, "ab"))).toEqual([`${KEY}.json`]);
  });

  it("misses on an absent, corrupt or malformed entry", async () => {
    const dir = scratch();
    const cache = directoryCache(dir);
    expect(await cache.get(KEY)).toBeUndefined();
    mkdirSync(join(dir, "ab"));
    writeFileSync(join(dir, "ab", `${KEY}.json`), "{not json");
    expect(await cache.get(KEY)).toBeUndefined();
    writeFileSync(
      join(dir, "ab", `${KEY}.json`),
      JSON.stringify({ definitions: [["x", "macro", 1, 1]], uses: [] }),
    );
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it("skips a write it cannot make", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "ab"), "a file where the shard directory should be");
    await expect(directoryCache(dir).set(KEY, SYMBOLS)).resolves.toBeUndefined();
    expect(await directoryCache(dir).get(KEY)).toBeUndefined();
  });
});
