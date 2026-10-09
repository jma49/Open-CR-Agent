import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Core's layer map (docs/architecture.md), lowest first. A module imports
// from its own layer or a lower one, type imports included. A top-level
// file is named without its extension, a directory with a trailing slash.
const LAYERS: readonly (readonly string[])[] = [
  ["contracts", "domain", "errors", "at", "hash", "bounded-file", "diff/", "net/"],
  // What every model call shares.
  ["agent/"],
  // The stages.
  [
    "select/",
    "rules/",
    "memory/",
    "triage",
    "review/",
    "bundle/",
    "anchor/",
    "verify/",
    "judge/",
    "sarif/",
    "matrix/",
  ],
  ["report/"],
  // What reads a report: the re-review compares with an earlier one, and a
  // VcsAdapter publishes one.
  ["rereview/", "vcs"],
  ["pipeline/"],
  // What plugs into a run: the session log, the plugin host, the runtime SPI.
  ["session/", "plugin/", "runtime/"],
  ["index", "internal"],
];

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /(?<!\.(test|fakes))\.ts$/.test(entry.name) ? [path] : [];
  });
}

// "agent/" for a file under agent/, "domain" for domain.ts.
function unitOf(path: string): string {
  const [first, ...rest] = relative(SRC, path).split("/");
  return rest.length > 0 ? `${first}/` : (first ?? "").replace(/\.[jt]s$/, "");
}

// Directed edges between units, each with the files that make it.
function unitImports(): Map<string, Map<string, string[]>> {
  const edges = new Map<string, Map<string, string[]>>();
  for (const file of sourceFiles(SRC)) {
    const from = unitOf(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(
      /(?:from|import)\s*\(?\s*"(\.{1,2}\/[^"]+)"/g,
    )) {
      const to = unitOf(resolve(dirname(file), specifier ?? ""));
      if (to === from) continue;
      const targets = edges.get(from) ?? new Map<string, string[]>();
      targets.set(to, [...(targets.get(to) ?? []), relative(SRC, file)]);
      edges.set(from, targets);
    }
  }
  return edges;
}

const layerOf = new Map(LAYERS.flatMap((units, layer) => units.map((u) => [u, layer] as const)));

describe("core's layers", () => {
  const edges = unitImports();

  it("place every top-level file and directory", () => {
    const units = new Set(sourceFiles(SRC).map(unitOf));
    expect([...units].filter((u) => !layerOf.has(u))).toEqual([]);
  });

  it("import only from the same layer or a lower one", () => {
    const upward: string[] = [];
    for (const [from, targets] of edges) {
      for (const [to, files] of targets) {
        if ((layerOf.get(to) ?? 0) > (layerOf.get(from) ?? 0)) {
          upward.push(`${from} -> ${to} (${files.join(", ")})`);
        }
      }
    }
    expect(upward).toEqual([]);
  });

  // Within a layer the stages may use each other, but not both ways.
  it("have no cycle between directories", () => {
    const cycles: string[] = [];
    const reaches = (start: string, goal: string, seen = new Set<string>()): boolean => {
      for (const next of edges.get(start)?.keys() ?? []) {
        if (next === goal) return true;
        if (seen.has(next)) continue;
        seen.add(next);
        if (reaches(next, goal, seen)) return true;
      }
      return false;
    };
    for (const [from, targets] of edges) {
      for (const to of targets.keys()) {
        if (from < to && reaches(to, from)) cycles.push(`${from} <-> ${to}`);
      }
    }
    expect(cycles).toEqual([]);
  });
});
