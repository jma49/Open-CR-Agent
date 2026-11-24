import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcraError } from "@open-cr-agent/core";
import { credentialEnvironment, GitError, git } from "./git.js";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REGULAR = new Set(["100644", "100755"]);
// A side larger than this is not merged again: the file is for a person.
const MAX_SIDE_BYTES = 1024 * 1024;
// How many conflicted paths are looked at; a merge with more is named in part.
const MAX_CONFLICTED = 50;
const PUSH_TIMEOUT_MS = 2 * 60_000;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

// A file both sides changed in the same lines, as text: `merged` is the
// three-way merge in diff3 style, ours first, with markers of `markerSize`
// characters, a size no line of the three versions starts with.
interface MergedFile {
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
  const { staged } = await mergedTree(root, ours, theirs);
  if (staged.size === 0) return undefined;
  const conflicts: MergeConflicts = { files: [], other: [] };
  for (const [path, stages] of [...staged].slice(0, MAX_CONFLICTED)) {
    const file = await mergedText(root, path, stages);
    if (file) conflicts.files.push(file);
    else conflicts.other.push(path);
  }
  // Any path left to a person stops the merge, so one more name is enough.
  const beyond = [...staged.keys()][MAX_CONFLICTED];
  if (beyond !== undefined) conflicts.other.push(beyond);
  return conflicts;
}

// git's merge of the two commits as a tree in the object store, and the
// index stages of each path it could not merge.
async function mergedTree(
  root: string,
  ours: string,
  theirs: string,
): Promise<{ tree: string; staged: Map<string, Map<string, Stage>> }> {
  const out = await git(
    ["-c", "merge.renames=true", "merge-tree", "--write-tree", "-z", "--no-messages", ours, theirs],
    { cwd: root, okExitCodes: [0, 1] },
  );
  const [tree = "", ...entries] = out.split("\0");
  const staged = new Map<string, Map<string, Stage>>();
  for (const entry of entries) {
    const match = /^(\d{6}) ([0-9a-f]+) ([123])\t(.+)$/s.exec(entry);
    if (!match) continue;
    const [, mode = "", oid = "", stage = "", path = ""] = match;
    const stages = staged.get(path) ?? new Map<string, Stage>();
    stages.set(stage, { mode, oid });
    staged.set(path, stages);
  }
  return { tree, staged };
}

export interface MergePush {
  ours: string;
  theirs: string;
  message: string;
  // The whole content of every file the merge conflicted in.
  files: readonly { path: string; content: string }[];
  // The branch `ours` is the head of, on `remote`.
  branch: string;
  author: { name: string; email: string };
  remote?: string;
}

export type MergePushed =
  | { committed: true; sha: string }
  | { committed: false; outcome: "head_moved" | "not_writable"; reason: string };

// The merge of `theirs` into `ours` as one commit with both parents, its
// tree git's own merge with `files` in place of the files that conflicted,
// then pushed to the branch without force: the remote takes it only while
// the branch is still at `ours`. Objects are written to the object store
// alone: no checkout, no index of the work tree, no hook.
export async function pushMerge(root: string, merge: MergePush): Promise<MergePushed> {
  if (!SHA.test(merge.ours) || !SHA.test(merge.theirs)) {
    throw new OcraError("INPUT_INVALID", "a merge is made between two commit ids");
  }
  if (!BRANCH.test(merge.branch) || merge.branch.includes("..") || merge.branch.startsWith("-")) {
    throw new OcraError("INPUT_INVALID", "not a branch name ocra pushes to");
  }
  const { tree, staged } = await mergedTree(root, merge.ours, merge.theirs);
  const given = new Set(merge.files.map((f) => f.path));
  if (given.size !== staged.size || [...staged.keys()].some((path) => !given.has(path))) {
    throw new OcraError(
      "INPUT_INVALID",
      "a merge is written with every conflicted file resolved, and no other file",
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "ocra-merge-"));
  try {
    const index = { GIT_INDEX_FILE: join(dir, "index") };
    await git(["read-tree", tree], { cwd: root, env: index });
    for (const file of merge.files) {
      const mode = staged.get(file.path)?.get("2")?.mode;
      if (!mode || !REGULAR.has(mode)) {
        throw new OcraError("INPUT_INVALID", `not a regular file of the merge: ${file.path}`);
      }
      const blob = await git(["hash-object", "-w", "--stdin"], { cwd: root, input: file.content });
      await git(["update-index", "--cacheinfo", `${mode},${blob.trim()},${file.path}`], {
        cwd: root,
        env: index,
      });
    }
    const written = (await git(["write-tree"], { cwd: root, env: index })).trim();
    const { name, email } = merge.author;
    const sha = (
      await git(["commit-tree", written, "-p", merge.ours, "-p", merge.theirs], {
        cwd: root,
        input: merge.message,
        env: {
          GIT_AUTHOR_NAME: name,
          GIT_AUTHOR_EMAIL: email,
          GIT_COMMITTER_NAME: name,
          GIT_COMMITTER_EMAIL: email,
        },
      })
    ).trim();
    return await push(root, sha, merge.branch, merge.remote ?? "origin");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function push(
  root: string,
  sha: string,
  branch: string,
  remote: string,
): Promise<MergePushed> {
  try {
    // The clone's hooks are not the reviewed tree's, but none has a say here.
    await git(
      [
        "-c",
        "core.hooksPath=/dev/null",
        "push",
        "--quiet",
        "--no-verify",
        "--end-of-options",
        remote,
        `${sha}:refs/heads/${branch}`,
      ],
      {
        cwd: root,
        timeoutMs: PUSH_TIMEOUT_MS,
        env: { ...credentialEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
      },
    );
    return { committed: true, sha };
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    if (/non-fast-forward|fetch first|\[rejected\]/.test(error.stderr)) {
      return {
        committed: false,
        outcome: "head_moved",
        reason: "the branch moved after ocra read it",
      };
    }
    // git may print the remote's URL, which can hold a credential.
    const said =
      error.stderr
        .replace(/\/\/[^@/\s]+@/g, "//")
        .trim()
        .split("\n")
        .at(-1) ?? "";
    return {
      committed: false,
      outcome: "not_writable",
      reason: `git refused the push: ${said}`,
    };
  }
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
      [
        "merge-file",
        "-p",
        "--diff3",
        `--marker-size=${markerSize}`,
        ...["ours", "base", "theirs"].flatMap((label) => ["-L", label]),
        ...names,
      ],
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
