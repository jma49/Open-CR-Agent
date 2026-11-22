import type { StackGit } from "./git.js";

// A branch's place in a stack: its parent, and the parent's commit it is
// built on, which restack replays it from (ADR-0053).
export interface StackLink {
  parent: string;
  parentHead: string;
}

export type StackLinks = ReadonlyMap<string, StackLink>;

const PARENT = "ocraparent";
const PARENT_HEAD = "ocraparenthead";

export async function readLinks(git: StackGit): Promise<Map<string, StackLink>> {
  const listed = await git
    .run(["config", "--local", "--get-regexp", `^branch\\..*\\.(${PARENT}|${PARENT_HEAD})$`])
    .catch(() => "");
  const parents = new Map<string, string>();
  const heads = new Map<string, string>();
  for (const line of listed.split("\n")) {
    const space = line.indexOf(" ");
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    const dot = key.lastIndexOf(".");
    const branch = key.slice("branch.".length, dot);
    (key.slice(dot + 1) === PARENT ? parents : heads).set(branch, value);
  }
  const links = new Map<string, StackLink>();
  for (const [branch, parent] of parents) {
    const parentHead = heads.get(branch);
    if (parentHead) links.set(branch, { parent, parentHead });
  }
  return links;
}

export async function writeLink(git: StackGit, branch: string, link: StackLink): Promise<void> {
  await git.run(["config", "--local", `branch.${branch}.${PARENT}`, link.parent]);
  await git.run(["config", "--local", `branch.${branch}.${PARENT_HEAD}`, link.parentHead]);
}
