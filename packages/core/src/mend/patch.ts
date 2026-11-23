// Whole lines of a file at the head and what replaces them: lines joined by
// "\n", without a trailing newline; empty deletes them.
export interface Hunk {
  path: string;
  startLine: number;
  endLine: number;
  replacement: string;
}

// What one work item changes, against the head. Every lane hands over this
// and nothing else, so the gate, the verification and the commit never ask
// how a patch was made (ADR-0078 point 13).
export interface ItemPatch {
  item: string;
  hunks: readonly Hunk[];
}

export interface FileChange {
  path: string;
  before: string;
  after: string;
}

function replacementLines(hunk: Hunk): string[] {
  return hunk.replacement === "" ? [] : hunk.replacement.split("\n");
}

export function replacedLines(content: string, hunk: Hunk): string[] {
  return content.split("\n").slice(hunk.startLine - 1, hunk.endLine);
}

// The hunks may not overlap: the last one is applied first, so the lines of
// the others keep their numbers.
export function applyHunks(content: string, hunks: readonly Hunk[]): string {
  const lines = content.split("\n");
  for (const hunk of [...hunks].sort((a, b) => b.startLine - a.startLine)) {
    lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...replacementLines(hunk));
  }
  return lines.join("\n");
}

function overlap(a: Hunk, b: Hunk): boolean {
  return a.path === b.path && a.startLine <= b.endLine && b.startLine <= a.endLine;
}

export interface CompositionLimits {
  files: number;
  addedLines: number;
}

export interface Composition {
  changes: FileChange[];
  // The items whose patches the changes hold, in the order given.
  kept: string[];
  // A patch left out touches lines an earlier one changes, or would take the
  // round past its limits; alone it may fit the next round.
  left: { item: string; reason: "overlap" | "no_room" }[];
}

// One round's change from its items' patches, the first given first: a patch
// is taken whole or left out.
export function composePatches(
  patches: readonly ItemPatch[],
  heads: ReadonlyMap<string, string>,
  limits: CompositionLimits,
): Composition {
  const taken: Hunk[] = [];
  const kept: string[] = [];
  const left: Composition["left"] = [];
  let added = 0;
  for (const patch of patches) {
    const lines = addedLines(patch);
    const files = new Set([...taken, ...patch.hunks].map((h) => h.path));
    if (patch.hunks.some((h) => taken.some((t) => overlap(t, h)))) {
      left.push({ item: patch.item, reason: "overlap" });
    } else if (files.size > limits.files || added + lines > limits.addedLines) {
      left.push({ item: patch.item, reason: "no_room" });
    } else {
      taken.push(...patch.hunks);
      kept.push(patch.item);
      added += lines;
    }
  }
  const changes = [...new Set(taken.map((h) => h.path))].sort().map((path) => {
    const before = heads.get(path) ?? "";
    const hunks = taken.filter((h) => h.path === path);
    return { path, before, after: applyHunks(before, hunks) };
  });
  return { changes, kept, left };
}

export function addedLines(patch: ItemPatch): number {
  return patch.hunks.reduce((sum, h) => sum + replacementLines(h).length, 0);
}
