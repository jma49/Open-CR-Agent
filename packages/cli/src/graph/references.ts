import { graphReferences } from "@open-cr-agent/code-graph";
import { errorMessage, type ReferenceIndex } from "@open-cr-agent/core";
import { readGraphFile } from "./file.js";

// The first index that knows the symbol answers: a precise one (SCIP)
// before the name-matched graph.
export function firstReferences(indexes: readonly ReferenceIndex[]): ReferenceIndex | undefined {
  if (indexes.length <= 1) return indexes[0];
  return {
    async usesOf(path, name) {
      for (const index of indexes) {
        const uses = await index.usesOf(path, name);
        if (uses) return uses;
      }
      return undefined;
    },
  };
}

// A graph file `ocra graph` wrote, read once on first use.
export function graphFileReferences(file: string, warn: (message: string) => void): ReferenceIndex {
  let loaded: Promise<ReferenceIndex | undefined> | undefined;
  return {
    async usesOf(path, name) {
      loaded ??= readGraphFile(file).then(graphReferences, (error: unknown) => {
        warn(
          `code graph ${file} could not be read (${errorMessage(error)}); callers are found by search`,
        );
        return undefined;
      });
      return (await loaded)?.usesOf(path, name);
    },
  };
}
