import { git } from "./git.js";

// Fix commits in a repository's history, read the same way by the learning
// miner (ocra learn) and the golden-case miner (ocra-eval). Every call reads
// objects only: nothing is checked out and nothing from the repository runs.

// A fix touching more source files than this is usually a refactor that
// happens to say "fix"; it says little about one defect.
export const MAX_FIX_FILES = 5;
// History older than this many first-parent commits is not mined.
const MAX_COMMITS = 5_000;
const SHA = /^[0-9a-f]{40}$/;

// Conventional Commits' fix and revert, plus the plain wording of
// repositories that do not use them.
const FIX_SUBJECT = /^(fix|revert)(\([^)]*\))?!?:|^revert\b|\b(fix(es|ed)?|bug)\b/i;

export function isFixSubject(subject: string): boolean {
  return FIX_SUBJECT.test(subject);
}

// Source files only: a defect in docs, tests, snapshots, lockfiles or
// generated data is not what the reviewers are asked to find.
const NOT_SOURCE =
  /\.(md|mdx|rst|txt|json|jsonc|lock|snap|ya?ml|toml|svg|png|jpe?g|gif|csv)$|(^|\/)(CHANGELOG|LICENSE)[^/]*$|\.(test|spec|e2e)\.|(^|\/)(__snapshots__|__tests__|tests?|fixtures?|\.changeset)\//i;

export function isMinedPath(path: string): boolean {
  return !NOT_SOURCE.test(path);
}

export interface FixCommit {
  sha: string;
  subject: string;
}

// Newest first, on the first-parent line of `ref`.
export async function fixCommits(root: string, ref: string): Promise<FixCommit[]> {
  const log = await git(
    [
      "log",
      "--first-parent",
      "--no-merges",
      `--max-count=${MAX_COMMITS}`,
      "--format=%H%x00%s%x00",
      "--end-of-options",
      ref,
    ],
    { cwd: root },
  );
  const fields = log.split("\0");
  const fixes: FixCommit[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i]?.trim() ?? "";
    const subject = fields[i + 1] ?? "";
    if (SHA.test(sha) && isFixSubject(subject)) fixes.push({ sha, subject });
  }
  return fixes;
}

// The source files a fix changed, as it named them.
export async function fixedFiles(root: string, sha: string): Promise<string[]> {
  if (!SHA.test(sha)) return [];
  const names = await git(["diff", "--name-only", "-z", "--no-renames", `${sha}^`, sha], {
    cwd: root,
  });
  return names.split("\0").filter((f) => f !== "" && isMinedPath(f));
}
