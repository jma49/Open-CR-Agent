import { GitError, git } from "./git.js";

export type ChangedFiles = { files: string[] } | { reason: string };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// The files that differ between two commits, when `to` descends from `from`.
// After a force-push or rebase `from` is no longer an ancestor, and a commit
// that was never fetched cannot be compared: both give a reason instead.
export async function filesChangedSince(
  root: string,
  from: string,
  to: string,
): Promise<ChangedFiles> {
  if (!SHA.test(from) || !SHA.test(to)) return { reason: "not a commit id" };
  const short = from.slice(0, 7);
  const type = await git(["cat-file", "-t", "--end-of-options", from], {
    cwd: root,
    okExitCodes: [0, 1, 128],
  });
  if (type.trim() !== "commit") return { reason: `commit ${short} is not available` };
  try {
    await git(["merge-base", "--is-ancestor", from, to], { cwd: root });
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) {
      return {
        reason: `commit ${short} is not an ancestor of the new head (force-push or rebase)`,
      };
    }
    throw error;
  }
  const out = await git(
    [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      from,
      to,
      "--",
    ],
    { cwd: root },
  );
  return { files: out.split("\0").filter((p) => p !== "") };
}
