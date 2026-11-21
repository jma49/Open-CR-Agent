import { execFile } from "node:child_process";
import { git, gitEnvironment } from "./git.js";

interface RevisionFile {
  path: string;
  blobId: string;
  size: number;
}

const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BLOB_TIMEOUT_MS = 60_000;

export async function resolveCommit(root: string, rev: string): Promise<string> {
  return (
    await git(["rev-parse", "--verify", "--end-of-options", `${rev}^{commit}`], { cwd: root })
  ).trim();
}

// Every file of a commit, as a code graph lists it: regular and executable
// files only (a symlink's blob is a path, a submodule has none).
export async function revisionFiles(root: string, commit: string): Promise<RevisionFile[]> {
  const out = await git(["ls-tree", "-r", "-l", "-z", "--full-tree", "--end-of-options", commit], {
    cwd: root,
  });
  return out.split("\0").flatMap((record) => {
    const tab = record.indexOf("\t");
    const [mode, type, blobId, size] = record.slice(0, tab).split(/ +/);
    const path = record.slice(tab + 1);
    if (tab < 0 || type !== "blob" || !(mode === "100644" || mode === "100755")) return [];
    if (!blobId || !OBJECT_ID.test(blobId)) return [];
    return [{ path, blobId, size: Number(size) }];
  });
}

// A blob's raw bytes, which no filter or textconv driver sees; undefined
// when it is not there or larger than maxBytes.
export function blobReader(
  root: string,
  maxBytes: number,
): (blobId: string) => Promise<Uint8Array | undefined> {
  const env = { ...gitEnvironment(process.env), LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" };
  return (blobId) =>
    new Promise((resolve) => {
      if (!OBJECT_ID.test(blobId)) {
        resolve(undefined);
        return;
      }
      execFile(
        "git",
        ["cat-file", "blob", "--end-of-options", blobId],
        { cwd: root, env, encoding: "buffer", maxBuffer: maxBytes, timeout: BLOB_TIMEOUT_MS },
        (error, stdout) => resolve(error ? undefined : new Uint8Array(stdout)),
      );
    });
}
