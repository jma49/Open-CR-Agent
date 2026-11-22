import { OcraError } from "@open-cr-agent/core";
import type { StackGit } from "./git.js";
import { type StackLinks, writeLink } from "./links.js";

export interface Restacked {
  moved: string[];
  // Already on their parent's tip.
  kept: string[];
}

// Replays each branch onto its parent's tip, bottom to top (ADR-0053), and
// returns to the branch it started on. A conflict stops at that branch with
// the rebase left to finish; a second run skips what is already in place.
export async function restack(
  git: StackGit,
  links: StackLinks,
  order: readonly string[],
  trunk: string,
): Promise<Restacked> {
  await git.assertClean();
  const start = await git.currentBranch();
  const trunkRef = await git.trunkRef(trunk);
  const result: Restacked = { moved: [], kept: [] };
  for (const branch of order) {
    const link = links.get(branch);
    if (!link) continue;
    const tip = await git.commit(link.parent === trunk ? trunkRef : `refs/heads/${link.parent}`);
    if (await git.isAncestor(tip, `refs/heads/${branch}`)) {
      result.kept.push(branch);
    } else {
      try {
        await git.run(["rebase", "--onto", tip, link.parentHead, branch]);
      } catch (error) {
        throw new OcraError(
          "VCS_GIT_FAILED",
          `Restack stopped at ${branch}: resolve the conflict, run git rebase --continue, then ocra stack restack again`,
          { cause: error },
        );
      }
      result.moved.push(branch);
    }
    if (link.parentHead !== tip)
      await writeLink(git, branch, { parent: link.parent, parentHead: tip });
  }
  if ((await git.currentBranch()) !== start) await git.run(["switch", "--quiet", start]);
  return result;
}
