import type { FileSymbols, SymbolKind } from "@open-cr-agent/core";
import { describe, expect, it } from "vitest";
import type { SymbolCache } from "./cache.js";
import { treeSitterSymbols } from "./extractor.js";

const extractor = treeSitterSymbols();

async function symbols(path: string, lines: string[]): Promise<FileSymbols> {
  const found = await extractor.symbols(path, `${lines.join("\n")}\n`);
  if (!found) throw new Error(`no symbols for ${path}`);
  return found;
}

function definitions(found: FileSymbols): [string, SymbolKind, number, number][] {
  return found.definitions.map((d) => [d.name, d.kind, d.startLine, d.endLine]);
}

describe("treeSitterSymbols", () => {
  it("finds TypeScript definitions with their full ranges", async () => {
    const found = await symbols("src/retry.ts", [
      "export async function parseRetries(input: string) {",
      "  return toLimit(Number(input));",
      "}",
      "export const toLimit = (n: number): number => n;",
      "export class RetryPolicy {",
      "  run(): number {",
      "    return parseRetries('3');",
      "  }",
      "}",
      "interface Options { limit: number }",
      "type Mode = 'fast' | 'slow';",
      "enum Level { Low, High }",
      "export const DEFAULTS = { limit: 3 };",
    ]);
    expect(definitions(found)).toEqual([
      ["parseRetries", "function", 1, 3],
      ["toLimit", "function", 4, 4],
      ["RetryPolicy", "class", 5, 9],
      ["run", "method", 6, 8],
      ["Options", "interface", 10, 10],
      ["Mode", "type", 11, 11],
      ["Level", "enum", 12, 12],
      ["DEFAULTS", "variable", 13, 13],
    ]);
  });

  it("counts uses in code, never in comments or strings, nor the definition's own name", async () => {
    const found = await symbols("a.ts", [
      "export function toLimit(n: number) { return n; }",
      "// toLimit is documented here",
      "const label = 'toLimit';",
      "export const limit = toLimit(3) + toLimit(4);",
      "const call = { toLimit };",
    ]);
    expect(found.uses.get("toLimit")).toEqual([4, 5]);
  });

  it("reads TSX and JavaScript with their own grammars", async () => {
    const tsx = await symbols("App.tsx", [
      "export function App() {",
      "  return <Button onClick={save} />;",
      "}",
    ]);
    expect(definitions(tsx)).toEqual([["App", "function", 1, 3]]);
    expect(tsx.uses.get("save")).toEqual([2]);

    const js = await symbols("lib/run.mjs", [
      "export function run() { return helper(); }",
      "const helper = () => 1;",
      "class Runner { start() { run(); } }",
    ]);
    expect(definitions(js)).toEqual([
      ["run", "function", 1, 1],
      ["helper", "function", 2, 2],
      ["Runner", "class", 3, 3],
      ["start", "method", 3, 3],
    ]);
  });

  it("finds Python, Go, Rust and Java definitions", async () => {
    const python = await symbols("app/config.py", [
      "class Loader:",
      "    def load(self, path):",
      "        return parse(path)",
      "",
      "def parse(path):",
      "    return path",
      "LIMIT = 3",
    ]);
    expect(definitions(python)).toEqual([
      ["Loader", "class", 1, 3],
      ["load", "method", 2, 3],
      ["parse", "function", 5, 6],
      ["LIMIT", "variable", 7, 7],
    ]);
    expect(python.uses.get("parse")).toEqual([3]);

    const go = await symbols("server.go", [
      "package server",
      "type Server struct{}",
      "type Handler interface{ Serve() }",
      "type ID string",
      "func (s *Server) Serve() { Listen() }",
      "func Listen() {}",
      "const MaxConns = 3",
    ]);
    expect(definitions(go)).toEqual([
      ["Server", "class", 2, 2],
      ["Handler", "interface", 3, 3],
      ["Serve", "method", 3, 3],
      ["ID", "type", 4, 4],
      ["Serve", "method", 5, 5],
      ["Listen", "function", 6, 6],
      ["MaxConns", "variable", 7, 7],
    ]);
    expect(go.uses.get("Server")).toEqual([5]);

    const rust = await symbols("src/lib.rs", [
      "pub struct Store;",
      "impl Store {",
      "    pub fn open(&self) { connect(); }",
      "}",
      "fn connect() {}",
      "pub trait Backend { fn read(&self); }",
      "pub enum Mode { Fast }",
      "const MAX: u32 = 3;",
    ]);
    expect(definitions(rust)).toEqual([
      ["Store", "class", 1, 1],
      ["open", "method", 3, 3],
      ["connect", "function", 5, 5],
      ["Backend", "interface", 6, 6],
      ["read", "method", 6, 6],
      ["Mode", "enum", 7, 7],
      ["MAX", "variable", 8, 8],
    ]);
    expect(rust.uses.get("Store")).toEqual([2]);

    const java = await symbols("src/Main.java", [
      "class Main {",
      "  Main() {}",
      "  void run() { helper(); }",
      "  static void helper() {}",
      "}",
      "interface Task { void go(); }",
      "enum Level { LOW }",
    ]);
    expect(definitions(java)).toEqual([
      ["Main", "class", 1, 5],
      ["Main", "method", 2, 2],
      ["run", "method", 3, 3],
      ["helper", "method", 4, 4],
      ["Task", "interface", 6, 6],
      ["go", "method", 6, 6],
      ["Level", "enum", 7, 7],
    ]);
  });

  it("leaves unknown languages and oversized files to the caller", async () => {
    expect(await extractor.symbols("README.md", "# title\n")).toBeUndefined();
    expect(await extractor.symbols("big.ts", "x".repeat(1_000_001))).toBeUndefined();
  });

  it("still finds the definitions around a syntax error", async () => {
    const found = await symbols("broken.ts", [
      "export function before() {}",
      "const = ;",
      "export function after() {}",
    ]);
    expect(found.definitions.map((d) => d.name)).toEqual(["before", "after"]);
  });

  it("reads a cached entry instead of parsing, and stores what it parses", async () => {
    const stored = new Map<string, FileSymbols>();
    const cached: FileSymbols = {
      definitions: [{ name: "fromCache", kind: "function", startLine: 1, endLine: 1 }],
      uses: new Map(),
    };
    const cache: SymbolCache = {
      get: async (key) => stored.get(key),
      set: async (key, symbols) => {
        stored.set(key, symbols);
      },
    };
    const content = "export function parsed() {}\n";
    const first = await treeSitterSymbols({ cache }).symbols("a.ts", content);
    expect(first?.definitions.map((d) => d.name)).toEqual(["parsed"]);
    const [key] = [...stored.keys()];
    if (key === undefined) throw new Error("nothing was cached");
    stored.set(key, cached);
    expect(await treeSitterSymbols({ cache }).symbols("a.ts", content)).toBe(cached);
    // The same content parsed as another language has its own entry.
    await treeSitterSymbols({ cache }).symbols("a.js", content);
    expect(stored.size).toBe(2);
  });
});
