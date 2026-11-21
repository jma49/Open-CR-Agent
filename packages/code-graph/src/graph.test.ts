import { describe, expect, it } from "vitest";
import { gitBlobId } from "./cache.js";
import {
  type CodeGraph,
  graphReferences,
  parseGraph,
  serializeGraph,
  updateGraph,
} from "./graph.js";

const RETRY = "export function parseRetries(input: string): number {\n  return Number(input);\n}\n";
const API =
  "import { parseRetries } from './retry';\nexport function handle(h: string) {\n  return parseRetries(h);\n}\n";
const MAIN = "// parseRetries is mentioned here only\nconst n = parseRetries('3');\n";

function repo(files: Record<string, string>) {
  const blobs = new Map<string, Uint8Array>();
  const tree = Object.entries(files).map(([path, content]) => {
    const bytes = new TextEncoder().encode(content);
    const blobId = gitBlobId(content);
    blobs.set(blobId, bytes);
    return { path, blobId, size: bytes.byteLength };
  });
  const reads: string[] = [];
  const readBlob = async (blobId: string, path: string) => {
    reads.push(path);
    return blobs.get(blobId);
  };
  return { tree, readBlob, reads };
}

describe("updateGraph", () => {
  it("parses a revision's files, then only the ones the next revision changed", async () => {
    const first = repo({ "src/retry.ts": RETRY, "src/api.ts": API, "README.md": "# app" });
    const built = await updateGraph(undefined, first.tree, first.readBlob, { revision: "a" });
    expect(built).toMatchObject({ parsed: 2, reused: 0, skipped: [] });
    expect(first.reads.sort()).toEqual(["src/api.ts", "src/retry.ts"]);
    expect(built.graph.revision).toBe("a");
    expect([...built.graph.files.keys()]).toEqual(["src/api.ts", "src/retry.ts"]);

    const second = repo({ "src/retry.ts": RETRY, "src/api.ts": `${API}\n`, "src/main.ts": MAIN });
    const next = await updateGraph(built.graph, second.tree, second.readBlob);
    expect(next).toMatchObject({ parsed: 2, reused: 1 });
    expect(second.reads.sort()).toEqual(["src/api.ts", "src/main.ts"]);
  });

  it("parses a blob once for all the paths that hold it", async () => {
    const { tree, readBlob, reads } = repo({ "a/retry.ts": RETRY, "b/retry.ts": RETRY });
    const { graph, parsed } = await updateGraph(undefined, tree, readBlob);
    expect(parsed).toBe(1);
    expect(reads).toHaveLength(1);
    expect(graph.files.get("a/retry.ts")).toBe(graph.files.get("b/retry.ts"));
  });

  it("parses everything again when another parser made the previous graph", async () => {
    const { tree, readBlob } = repo({ "src/retry.ts": RETRY });
    const { graph } = await updateGraph(undefined, tree, readBlob);
    const stale: CodeGraph = { ...graph, parser: "older" };
    expect(await updateGraph(stale, tree, readBlob)).toMatchObject({ parsed: 1, reused: 0 });
  });

  it("skips and records a file it cannot read, decode or keep, and keeps the rest", async () => {
    const { tree, readBlob } = repo({ "src/retry.ts": RETRY, "src/api.ts": API });
    const entries = [
      ...tree,
      { path: "big/declared.ts", blobId: "1".repeat(40), size: 2_000_000 },
      { path: "big/actual.ts", blobId: "2".repeat(40) },
      { path: "gone.ts", blobId: "3".repeat(40) },
      { path: "throws.ts", blobId: "4".repeat(40) },
      { path: "binary.ts", blobId: "5".repeat(40) },
    ];
    const read = async (blobId: string, path: string) => {
      if (blobId === "2".repeat(40)) return new Uint8Array(20);
      if (blobId === "4".repeat(40)) throw new Error("network");
      if (blobId === "5".repeat(40)) return new Uint8Array([0xff, 0xfe, 0x00]);
      return readBlob(blobId, path);
    };
    const update = await updateGraph(undefined, entries, read, { maxBlobBytes: 10_000 });
    const small = await updateGraph(undefined, entries, read, { maxBlobBytes: 10 });
    expect(update.skipped).toEqual([
      { path: "big/declared.ts", reason: "too-large" },
      { path: "binary.ts", reason: "not-text" },
      { path: "gone.ts", reason: "unreadable" },
      { path: "throws.ts", reason: "unreadable" },
    ]);
    expect(small.skipped).toContainEqual({ path: "big/actual.ts", reason: "too-large" });
    expect([...update.graph.files.keys()]).toEqual(["big/actual.ts", "src/api.ts", "src/retry.ts"]);
  });

  it("stops at maxFiles and records the rest", async () => {
    const { tree, readBlob } = repo({ "a.ts": RETRY, "b.ts": API, "c.ts": MAIN });
    const { graph, skipped } = await updateGraph(undefined, tree, readBlob, { maxFiles: 2 });
    expect([...graph.files.keys()]).toEqual(["a.ts", "b.ts"]);
    expect(skipped).toEqual([{ path: "c.ts", reason: "over-limit" }]);
  });

  it("rejects once the signal aborts", async () => {
    const { tree, readBlob } = repo({ "src/retry.ts": RETRY });
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(
      updateGraph(undefined, tree, readBlob, { signal: controller.signal }),
    ).rejects.toThrow("stopped");
  });
});

describe("graphReferences", () => {
  it("lists the uses of a name the file defines, in the revision's other files", async () => {
    const { tree, readBlob } = repo({
      "src/retry.ts": RETRY,
      "src/api.ts": API,
      "src/main.ts": MAIN,
    });
    const { graph } = await updateGraph(undefined, tree, readBlob);
    const index = graphReferences(graph);
    expect(await index.usesOf("src/retry.ts", "parseRetries")).toEqual([
      { path: "src/api.ts", line: 1 },
      { path: "src/api.ts", line: 3 },
      { path: "src/main.ts", line: 2 },
    ]);
    expect(await index.usesOf("src/api.ts", "parseRetries")).toBeUndefined();
    expect(await index.usesOf("src/unknown.ts", "parseRetries")).toBeUndefined();
  });
});

describe("serializeGraph", () => {
  it("writes the same text for the same graph, and reads it back", async () => {
    const files = { "src/retry.ts": RETRY, "src/api.ts": API };
    const one = repo(files);
    const other = repo(Object.fromEntries(Object.entries(files).reverse()));
    const a = (await updateGraph(undefined, one.tree, one.readBlob, { revision: "r" })).graph;
    const b = (await updateGraph(undefined, other.tree, other.readBlob, { revision: "r" })).graph;
    const text = serializeGraph(a);
    expect(serializeGraph(b)).toBe(text);
    expect(parseGraph(text)).toEqual(a);
  });

  it("refuses text that is not a graph of a format it reads", async () => {
    const { tree, readBlob } = repo({ "src/retry.ts": RETRY });
    const text = serializeGraph((await updateGraph(undefined, tree, readBlob)).graph);
    expect(parseGraph(text.replace('"format":1', '"format":2'))).toBeUndefined();
    expect(parseGraph("{not json")).toBeUndefined();
    expect(parseGraph(JSON.stringify({ format: 1 }))).toBeUndefined();
  });
});
