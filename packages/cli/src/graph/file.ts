import { readFile, stat } from "node:fs/promises";
import { type CodeGraph, parseGraph } from "@open-cr-agent/code-graph";

// Larger graphs would not fit in memory once parsed.
export const MAX_GRAPH_BYTES = 512 * 1024 * 1024;

/** The graph in `file`; throws when it is missing, too large or not a graph this version reads. */
export async function readGraphFile(file: string): Promise<CodeGraph> {
  const { size } = await stat(file);
  if (size > MAX_GRAPH_BYTES) throw new Error(`${size} bytes, more than ${MAX_GRAPH_BYTES}`);
  const graph = parseGraph(await readFile(file, "utf8"));
  if (!graph) throw new Error("not a code graph this version of ocra reads");
  return graph;
}
