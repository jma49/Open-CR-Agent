import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  type ChangeRequest,
  type FileDiff,
  type PriorReview,
  parseUnifiedDiff,
  type VcsAdapter,
} from "@open-cr-agent/core";
import { GitError, git } from "./git.js";

export type LocalTarget =
  | { mode: "workspace" }
  | { mode: "range"; from: string; to: string }
  | { mode: "commit"; commit: string };

export interface LocalGitOptions {
  cwd: string;
  target: LocalTarget;
}

interface ResolvedTarget {
  root: string;
  base: string;
  head: string | undefined;
  request: ChangeRequest;
}

const WORKING_TREE = "working-tree";

// Explicit prefixes and flags keep the output parseable whatever the user's
// diff configuration (noprefix, mnemonicPrefix, external drivers, relative).
const DIFF_ARGS = [
  "-c",
  "core.quotepath=true",
  "diff",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--find-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

export class LocalGitAdapter implements VcsAdapter {
  readonly name = "local";
  private resolved: Promise<ResolvedTarget> | undefined;

  constructor(private readonly options: LocalGitOptions) {}

  async getChangeRequest(): Promise<ChangeRequest> {
    return (await this.target()).request;
  }

  async getDiff(): Promise<FileDiff[]> {
    const { root, base, head } = await this.target();
    if (head !== undefined) {
      return parseUnifiedDiff(await git([...DIFF_ARGS, base, head, "--"], { cwd: root }));
    }
    const tracked = await git([...DIFF_ARGS, base, "--"], { cwd: root });
    const untracked = await this.untrackedDiffs(root);
    return parseUnifiedDiff(tracked + untracked);
  }

  async readFile(path: string): Promise<string | undefined> {
    const { root, head } = await this.target();
    const inside = relativeInside(root, resolve(root, path));
    if (inside === undefined) return undefined;

    if (head === undefined) return readWorkingTreeFile(root, inside);

    try {
      return await git(["cat-file", "blob", `${head}:${inside.split(sep).join("/")}`], {
        cwd: root,
      });
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 128) return undefined;
      throw error;
    }
  }

  async getPriorReview(): Promise<PriorReview | undefined> {
    return undefined;
  }

  async publish(): Promise<void> {}

  private target(): Promise<ResolvedTarget> {
    this.resolved ??= this.resolveTarget();
    return this.resolved;
  }

  private async resolveTarget(): Promise<ResolvedTarget> {
    const root = (await git(["rev-parse", "--show-toplevel"], { cwd: this.options.cwd })).trim();
    const target = this.options.target;

    if (target.mode === "workspace") {
      const base = (await tryVerifyCommit(root, "HEAD")) ?? (await emptyTree(root));
      return {
        root,
        base,
        head: undefined,
        request: request(WORKING_TREE, "Working tree changes", "", base, WORKING_TREE),
      };
    }

    if (target.mode === "range") {
      const from = await verifyCommit(root, target.from);
      const to = await verifyCommit(root, target.to);
      const base = (await git(["merge-base", from, to], { cwd: root })).trim();
      const subjects = await git(["log", "--format=- %s", `${base}..${to}`], { cwd: root });
      const title = `Changes from ${target.from} to ${target.to}`;
      return {
        root,
        base,
        head: to,
        request: request(`${base}..${to}`, title, subjects.trim(), base, to),
      };
    }

    const head = await verifyCommit(root, target.commit);
    const base = (await tryVerifyCommit(root, `${head}^`)) ?? (await emptyTree(root));
    const message = (await git(["log", "-1", "--format=%B", head], { cwd: root })).trim();
    const [title = "", ...body] = message.split("\n");
    return {
      root,
      base,
      head,
      request: request(head, title, body.join("\n").trim(), base, head),
    };
  }

  private async untrackedDiffs(root: string): Promise<string> {
    const listing = await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
    const paths = listing.split("\0").filter((p) => p !== "");
    let text = "";
    for (const path of paths) {
      text += await git([...DIFF_ARGS, "--no-index", "--", "/dev/null", path], {
        cwd: root,
        okExitCodes: [0, 1],
      });
    }
    return text;
  }
}

function relativeInside(root: string, absolute: string): string | undefined {
  const inside = relative(root, absolute);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return undefined;
  }
  return inside;
}

// Symlinks are resolved before the containment check so a link inside the
// repository cannot expose files outside it.
async function readWorkingTreeFile(root: string, inside: string): Promise<string | undefined> {
  try {
    const real = await realpath(resolve(root, inside));
    if (relativeInside(await realpath(root), real) === undefined) return undefined;
    return await readFile(real, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function request(
  id: string,
  title: string,
  description: string,
  baseSha: string,
  headSha: string,
): ChangeRequest {
  return { id, title, description, baseSha, headSha };
}

async function verifyCommit(root: string, ref: string): Promise<string> {
  const sha = await tryVerifyCommit(root, ref);
  if (sha === undefined) throw new Error(`Unknown commit: ${ref}`);
  return sha;
}

// --end-of-options stops a user-supplied ref such as "--output=x" from being
// read as an option.
async function tryVerifyCommit(root: string, ref: string): Promise<string | undefined> {
  const out = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    {
      cwd: root,
      okExitCodes: [0, 1, 128],
    },
  );
  const sha = out.trim();
  return sha === "" ? undefined : sha;
}

async function emptyTree(root: string): Promise<string> {
  return (await git(["hash-object", "-t", "tree", "--stdin"], { cwd: root, input: "" })).trim();
}
