import type { StackLink, StackLinks } from "./links.js";

// The stack that holds `branch`, bottom to top: the tree of linked branches
// under the trunk, parents before children, siblings by name. Empty when
// the branch is in no stack.
export function stackOf(links: StackLinks, branch: string): string[] {
  if (!links.has(branch)) return [];
  let root = branch;
  const seen = new Set([root]);
  for (let parent = links.get(root)?.parent; parent && links.has(parent) && !seen.has(parent); ) {
    root = parent;
    seen.add(root);
    parent = links.get(root)?.parent;
  }
  const order: string[] = [];
  const visit = (node: string) => {
    if (order.includes(node)) return;
    order.push(node);
    for (const child of childrenOf(links, node)) visit(child);
  };
  visit(root);
  return order;
}

function childrenOf(links: StackLinks, branch: string): string[] {
  return [...links]
    .filter(([, link]) => link.parent === branch)
    .map(([child]) => child)
    .sort();
}

export function depthOf(links: StackLinks, branch: string): number {
  let depth = 0;
  const seen = new Set<string>();
  for (let node = branch; links.has(node) && !seen.has(node); depth += 1) {
    seen.add(node);
    node = links.get(node)?.parent ?? "";
  }
  return depth - 1;
}

// The links once the merged branches are gone: a child moves to its
// nearest unmerged ancestor (the trunk at worst), built on the tip of the
// merged parent it held, so the restack drops what merged even when it was
// squashed.
export function foldMerged(
  links: StackLinks,
  merged: ReadonlySet<string>,
  tips: ReadonlyMap<string, string>,
): Map<string, StackLink> {
  const folded = new Map<string, StackLink>();
  for (const [branch, link] of links) {
    if (merged.has(branch)) continue;
    if (!merged.has(link.parent)) {
      folded.set(branch, link);
      continue;
    }
    const parentHead = tips.get(link.parent) ?? link.parentHead;
    let parent = link.parent;
    const seen = new Set<string>();
    while (merged.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = links.get(parent)?.parent ?? parent;
    }
    folded.set(branch, { parent, parentHead });
  }
  return folded;
}
