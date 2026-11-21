import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema, SymbolRole } from "@scip-code/scip";
import { afterEach, describe, expect, it } from "vitest";
import { scipReferences, symbolName } from "./scip.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PARSE = "scip-typescript npm app 1.0.0 src/`retry.ts`/parseRetries().";
const RUN = "scip-typescript npm app 1.0.0 src/`a.ts`/Runner#run().";
const OTHER_RUN = "scip-typescript npm app 1.0.0 src/`b.ts`/Other#run().";

function occurrence(symbol: string, line: number, definition = false) {
  return {
    symbol,
    symbolRoles: definition ? SymbolRole.Definition : SymbolRole.ReadAccess,
    range: [line, 4, 10],
  };
}

function indexFile(documents: { relativePath: string; occurrences: object[] }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-scip-"));
  dirs.push(dir);
  const file = join(dir, "index.scip");
  writeFileSync(file, toBinary(IndexSchema, create(IndexSchema, { documents })));
  return file;
}

describe("symbolName", () => {
  it("reads the last descriptor's name", () => {
    expect(symbolName(PARSE)).toBe("parseRetries");
    expect(symbolName(RUN)).toBe("run");
    expect(symbolName("scip-java maven org.acme 1.0 org/acme/Retry#")).toBe("Retry");
    expect(symbolName("scip-python python app 0.1 `app.config`/LIMIT.")).toBe("LIMIT");
    expect(symbolName("rust-analyzer cargo my  crate 0.1 store/Store#open(+1).")).toBe("open");
    expect(symbolName("scip-typescript npm . . src/`a.ts`/`odd``name`.")).toBe("odd`name");
  });

  it("names nothing for parameters, type parameters and malformed symbols", () => {
    expect(symbolName("scip-typescript npm app 1.0.0 src/`a.ts`/f().(input)")).toBeUndefined();
    expect(symbolName("scip-typescript npm app 1.0.0 src/`a.ts`/Box#[T]")).toBeUndefined();
    expect(symbolName("too few fields")).toBeUndefined();
    expect(symbolName("scip-typescript npm app 1.0.0 src/`a.ts")).toBeUndefined();
  });
});

describe("scipReferences", () => {
  it("lists the uses of the symbol a file defines under a name, elsewhere", async () => {
    const file = indexFile([
      {
        relativePath: "src/retry.ts",
        occurrences: [occurrence(PARSE, 0, true), occurrence(PARSE, 7)],
      },
      { relativePath: "src/api.ts", occurrences: [occurrence(PARSE, 2), occurrence(PARSE, 2)] },
      { relativePath: "src/a.ts", occurrences: [occurrence(RUN, 1, true)] },
      { relativePath: "src/b.ts", occurrences: [occurrence(OTHER_RUN, 1, true)] },
      { relativePath: "src/main.ts", occurrences: [occurrence(RUN, 4), occurrence(OTHER_RUN, 9)] },
    ]);
    const index = scipReferences(file);
    expect(await index.usesOf("src/retry.ts", "parseRetries")).toEqual([
      { path: "src/api.ts", line: 3 },
    ]);
    // Two methods named run: each file's own.
    expect(await index.usesOf("src/a.ts", "run")).toEqual([{ path: "src/main.ts", line: 5 }]);
    expect(await index.usesOf("src/b.ts", "run")).toEqual([{ path: "src/main.ts", line: 10 }]);
    expect(await index.usesOf("src/api.ts", "parseRetries")).toBeUndefined();
  });

  it("warns once and answers nothing when the index cannot be read", async () => {
    const warnings: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ocra-scip-"));
    dirs.push(dir);
    const file = join(dir, "index.scip");
    writeFileSync(file, Buffer.from([0xff, 0xff, 0xff]));
    const index = scipReferences(file, { warn: (m) => warnings.push(m) });
    expect(await index.usesOf("src/a.ts", "run")).toBeUndefined();
    expect(await index.usesOf("src/a.ts", "run")).toBeUndefined();
    expect(await scipReferences(join(dir, "missing.scip")).usesOf("a", "b")).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("callers are found by search");
  });
});
