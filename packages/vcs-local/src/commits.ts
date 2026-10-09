import { OcraError } from "@open-cr-agent/core";
import { credentialEnvironment, git } from "./git.js";

const FETCH_TIMEOUT_MS = 5 * 60_000;

// Pull request commits are often missing from a local clone (shallow CI
// checkouts, fork heads). Fetch them by SHA first, then through the extra
// refspecs (for example pull/<n>/head), and name what is still missing.
export async function ensureCommits(
  root: string,
  shas: readonly string[],
  refspecs: readonly string[] = [],
  remote = "origin",
): Promise<void> {
  // Anything but a commit id could be read by git fetch as an option.
  const invalid = shas.filter((sha) => !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha));
  if (invalid.length > 0)
    throw new OcraError("INPUT_INVALID", `Not commit ids: ${invalid.join(", ")}`);
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
    // No credential prompt can block a non-interactive run.
    await git(["fetch", "--quiet", "--no-tags", remote, ...attempt], {
      cwd: root,
      okExitCodes: [0, 1, 128],
      timeoutMs: FETCH_TIMEOUT_MS,
      env: { ...credentialEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" },
    });
    absent = await missing();
  }
  if (absent.length > 0) {
    throw new OcraError(
      "VCS_REF_UNKNOWN",
      `Commits ${absent.join(", ")} are not in this repository and could not be fetched from ${remote}`,
    );
  }
}
