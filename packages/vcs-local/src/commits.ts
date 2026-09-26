import { git } from "./git.js";

// Pull request commits are often missing from a local clone (shallow CI
// checkouts, fork heads). Fetch them by SHA first, then through the extra
// refspecs (for example pull/<n>/head), and name what is still missing.
export async function ensureCommits(
  root: string,
  shas: readonly string[],
  refspecs: readonly string[] = [],
  remote = "origin",
): Promise<void> {
  const missing = async () => {
    const result: string[] = [];
    for (const sha of shas) {
      const out = await git(["cat-file", "-t", "--end-of-options", sha], {
        cwd: root,
        okExitCodes: [0, 1, 128],
      });
      if (out.trim() !== "commit") result.push(sha);
    }
    return result;
  };

  let absent = await missing();
  for (const attempt of [absent, refspecs]) {
    if (absent.length === 0) return;
    if (attempt.length === 0) continue;
    await git(["fetch", "--quiet", "--no-tags", remote, ...attempt], {
      cwd: root,
      okExitCodes: [0, 1, 128],
    });
    absent = await missing();
  }
  if (absent.length > 0) {
    throw new Error(
      `Commits ${absent.join(", ")} are not in this repository and could not be fetched from ${remote}`,
    );
  }
}
