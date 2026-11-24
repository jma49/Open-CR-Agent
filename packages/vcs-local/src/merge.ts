import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcraError } from "@open-cr-agent/core";
import { git } from "./git.js";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REGULAR = new Set(["100644", "100755"]);
// A side larger than this is not merged again: the file is for a person.
const MAX_SIDE_BYTES = 1024 * 1024;
// How many conflicted paths are looked at; a merge with more is named in part.
const MAX_CONFLICTED = 50;

// A file both sides changed in the same lines, as text: `merged` is the
// three-way merge in diff3 style, ours first, with markers of `markerSize`
// characters, a size no line of the three versions starts with.
export interface MergedFile {
  path: string;
  merged: string;
  markerSize: number;
  executable: boolean;
}

export interface MergeConflicts {
  files: MergedFile[];
  // Conflicted paths that are not a text conflict of one regular file:
  // deleted or renamed on a side, a changed mode, binary, too large.
  other: string[];
}

interface Stage {
  mode: string;
  oid: string;
}

// The conflicts of merging `theirs` into `ours`, read from the object store:
// nothing is checked out, no hook runs and no merge driver (ADR-0078 point
// 3). Undefined when the two merge cleanly.
export async function mergeConflicts(
  root: string,
  ours: string,
  theirs: string,
): Promise<MergeConflicts | undefined> {
  if (!SHA.test(ours) || !SHA.test(theirs)) {
    throw new OcraError("INPUT_INVALID", "a merge is read between two commit ids");
  }
  const out = await git(
    ["-c", "merge.renames=true", "merge-tree", "--write-tree", "-z", "--no-messages", ours, theirs],
    { cwd: root, okExitCodes: [0, 1] },
  );
  const staged = new Map<string, Map<string, Stage>>();
  for (const entry of out.split("\0").slice(1)) {
    const match = /^(\d{6}) ([0-9a-f]+) ([123])\t(.+)$/s.exec(entry);
    if (!match) continue;
    const [, mode = "", oid = "", stage = "", path = ""] = match;
    const stages = staged.get(path) ?? new Map<string, Stage>();
    stages.set(stage, { mode, oid });
    staged.set(path, stages);
  }
  if (staged.size === 0) return undefined;
  const conflicts: MergeConflicts = { files: [], other: [] };
  for (const [path, stages] of [...staged].slice(0, MAX_CONFLICTED)) {
    const file = await mergedText(root, path, stages);
    if (file) conflicts.files.push(file);
    else conflicts.other.push(path);
  }
  conflicts.other.push(...[...staged.keys()].slice(MAX_CONFLICTED));
  return conflicts;
}

async function mergedText(
  root: string,
  path: string,
  stages: ReadonlyMap<string, Stage>,
): Promise<MergedFile | undefined> {
  const base = stages.get("1");
  const ours = stages.get("2");
  const theirs = stages.get("3");
  if (!base || !ours || !theirs) return undefined;
  if (![base, ours, theirs].every((s) => REGULAR.has(s.mode)) || ours.mode !== theirs.mode) {
    return undefined;
  }
  const texts: string[] = [];
  for (const stage of [ours, base, theirs]) {
    const text = await blobText(root, stage.oid);
    if (text === undefined) return undefined;
    texts.push(text);
  }
  const markerSize = markerSizeFor(texts);
  const dir = await mkdtemp(join(tmpdir(), "ocra-merge-"));
  try {
    const names = ["ours", "base", "theirs"].map((name) => join(dir, name));
    await Promise.all(names.map((name, i) => writeFile(name, texts[i] ?? "")));
    // merge-file exits with the number of conflicts, and above 127 on an error.
    const merged = await git(
      ["merge-file", "-p", "--diff3", `--marker-size=${markerSize}`, ...names],
      { cwd: dir, okExitCodes: Array.from({ length: 128 }, (_, i) => i) },
    );
    return { path, merged, markerSize, executable: ours.mode === "100755" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// A blob as text; undefined for one that is too large, binary or written
// with carriage returns, which a line-by-line answer would not keep.
async function blobText(root: string, oid: string): Promise<string | undefined> {
  const size = Number((await git(["cat-file", "-s", oid], { cwd: root })).trim());
  if (!(size <= MAX_SIDE_BYTES)) return undefined;
  const text = await git(["cat-file", "blob", oid], { cwd: root });
  return text.includes("\0") || text.includes("\r") || text.includes("�") ? undefined : text;
}

// One more than the longest run of a marker's character at the start of a
// line of any version, and git's usual 7 at least.
function markerSizeFor(versions: readonly string[]): number {
  let longest = 0;
  for (const version of versions) {
    for (const run of version.matchAll(/^(<+|\|+|=+|>+)/gm)) {
      longest = Math.max(longest, run[0].length);
    }
  }
  return Math.max(7, longest + 1);
}
