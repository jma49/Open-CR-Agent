import { exec } from "./exec.js";
import {
  claimsFrom,
  type FixCommit,
  type IntroducingCommit,
  isFixSubject,
  isMinedPath,
  MAX_FIX_FILES,
  type MinedClaim,
  parseBlame,
  rewrittenRanges,
} from "./fix-mining.js";
import { GIT_ENV } from "./repos.js";

// The git half of fix mining. Every call reads objects only (log, diff,
// blame, show): nothing is checked out and nothing from the repository runs.
// Commit ids reach git only after the hex check of its own output.

const SHA = /^[0-9a-f]{40}$/;
// History older than this many first-parent commits is not mined.
const MAX_COMMITS = 5_000;

async function git(dir: string, args: readonly string[]): Promise<string> {
  const result = await exec("git", ["--no-pager", ...args], { cwd: dir, env: GIT_ENV });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.trim().split("\n")[0] ?? ""}`);
  }
  return result.stdout;
}

export async function fixCommits(dir: string, ref: string): Promise<FixCommit[]> {
  const log = await git(dir, [
    "log",
    "--first-parent",
    "--no-merges",
    `--max-count=${MAX_COMMITS}`,
    "--format=%H%x00%s%x00",
    "--end-of-options",
    ref,
  ]);
  const fields = log.split("\0");
  const fixes: FixCommit[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const sha = fields[i]?.trim() ?? "";
    const subject = fields[i + 1] ?? "";
    if (SHA.test(sha) && isFixSubject(subject)) fixes.push({ sha, subject });
  }
  return fixes;
}

// What one fix blames: the introduced lines it rewrote, as claims, or the
// reason it was skipped.
export async function blameFix(
  dir: string,
  fix: FixCommit,
): Promise<{ claims: MinedClaim[] } | { skipped: string }> {
  const parent = `${fix.sha}^`;
  const names = (await git(dir, ["diff", "--name-only", "-z", "--no-renames", parent, fix.sha]))
    .split("\0")
    .filter((f) => f !== "" && isMinedPath(f));
  if (names.length === 0) return { skipped: "no source file" };
  if (names.length > MAX_FIX_FILES) return { skipped: `more than ${MAX_FIX_FILES} source files` };
  const claims: MinedClaim[] = [];
  for (const file of names) {
    const diff = await git(dir, [
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      parent,
      fix.sha,
      "--",
      file,
    ]);
    for (const range of rewrittenRanges(diff)) {
      const blame = await git(dir, [
        "blame",
        "--porcelain",
        "-L",
        `${range.start},${range.start + range.count - 1}`,
        parent,
        "--",
        file,
      ]);
      claims.push(...claimsFrom(fix, file, parseBlame(blame)));
    }
  }
  return { claims };
}

// Undefined for a root or merge commit: neither is one reviewable change.
export async function introducingCommit(
  dir: string,
  sha: string,
): Promise<IntroducingCommit | undefined> {
  if (!SHA.test(sha)) return undefined;
  const [parents = "", subject = "", date = ""] = (
    await git(dir, ["show", "-s", "--format=%P%x00%s%x00%cs", sha])
  )
    .trim()
    .split("\0");
  const parent = parents.split(" ").filter(Boolean);
  if (parent.length !== 1 || !SHA.test(parent[0] ?? "")) return undefined;
  const numstat = await git(dir, ["diff", "--numstat", "--no-renames", `${sha}^`, sha]);
  const changedLines = numstat
    .split("\n")
    .map((row) => row.split("\t"))
    .reduce((sum, [added, deleted]) => sum + (Number(added) || 0) + (Number(deleted) || 0), 0);
  return { sha, parent: parent[0] as string, subject, date, changedLines };
}
