import type { StackGit } from "./git.js";
import type { PlacedHost } from "./host.js";
import { readLinks, writeLink } from "./links.js";
import { type Restacked, restack } from "./restack.js";
import { foldMerged, stackOf } from "./tree.js";

export interface Synced extends Restacked {
  merged: string[];
}

// Fetches, folds the branches whose change requests merged into their
// parents, deletes them, and restacks what is left (ADR-0053). It pushes
// nothing: submit does.
export async function sync(
  git: StackGit,
  { host }: Pick<PlacedHost, "host">,
  branch: string,
  trunk: string,
): Promise<Synced> {
  await git.assertClean();
  await git.run(["fetch", "--quiet", "--prune", "origin"]);
  const links = await readLinks(git);
  const order = stackOf(links, branch);
  const merged = new Set<string>();
  for (const b of order) {
    if ((await host.find(b))?.state === "merged") merged.add(b);
  }
  const tips = new Map<string, string>();
  for (const b of merged) tips.set(b, await git.commit(`refs/heads/${b}`));
  const folded = foldMerged(links, merged, tips);
  for (const [b, link] of folded) {
    const before = links.get(b);
    if (before?.parent !== link.parent || before.parentHead !== link.parentHead) {
      await writeLink(git, b, link);
    }
  }
  const remaining = order.filter((b) => !merged.has(b));
  if (merged.has(await git.currentBranch())) {
    await git.run(["switch", "--quiet", remaining[0] ?? trunk]);
  }
  for (const b of merged) await git.run(["branch", "--quiet", "-D", b]);
  const restacked =
    remaining.length > 0 ? await restack(git, folded, remaining, trunk) : { moved: [], kept: [] };
  return { merged: [...merged], ...restacked };
}
