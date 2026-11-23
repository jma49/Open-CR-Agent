import type { ScratchRepo } from "@open-cr-agent/test-support";

const MODULES = 12;
const FILES_PER_MODULE = 20;
const CHANGED_MODULES = 8;
const CHANGED_FILES_PER_MODULE = 2;

const pad = (n: number) => String(n).padStart(2, "0");
const path = (module: number, file: number) => `src/module${pad(module)}/part${pad(file)}.ts`;

// A module's file: functions that call the next module's, so a change has
// callers elsewhere and its names are found by a search.
function source(module: number, file: number, extra = ""): string {
  const next = pad((module + 1) % MODULES);
  const id = `${pad(module)}${pad(file)}`;
  return `import { computeTotal${next}${pad(file)} } from "../module${next}/part${pad(file)}.js";

export function computeTotal${id}(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

export function describeTotal${id}(values: readonly number[]): string {
  return \`total ${id}: \${computeTotal${id}(values) + computeTotal${next}${pad(file)}(values)}\`;
}
${extra}`;
}

/**
 * A repository of 240 small TypeScript files and a change to 16 of them in
 * 8 directories: the same files, lines and names on every machine, so what
 * a review of it costs can be held to a budget.
 */
export function syntheticChange(repo: ScratchRepo): { from: string; to: string } {
  const files: Record<string, string> = { "AGENTS.md": "# Guidelines\n\nKeep totals exact.\n" };
  for (let module = 0; module < MODULES; module++) {
    for (let file = 0; file < FILES_PER_MODULE; file++) {
      files[path(module, file)] = source(module, file);
    }
  }
  const from = repo.commit("base", files);
  const changed: Record<string, string> = {};
  for (let module = 0; module < CHANGED_MODULES; module++) {
    for (let file = 0; file < CHANGED_FILES_PER_MODULE; file++) {
      const id = `${pad(module)}${pad(file)}`;
      changed[path(module, file)] = source(
        module,
        file,
        `
export function averageTotal${id}(values: readonly number[]): number {
  return computeTotal${id}(values) / values.length;
}
`,
      );
    }
  }
  return { from, to: repo.commit("add averages", changed) };
}
