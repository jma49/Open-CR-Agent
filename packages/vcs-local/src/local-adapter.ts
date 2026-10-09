import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ChangeRequest,
  type CodeMatch,
  type FileDiff,
  OcraError,
  type PriorReview,
  type VcsAdapter,
} from "@open-cr-agent/core";
import { isNotFound, parseUnifiedDiff } from "@open-cr-agent/core/internal";
import { attributesFrom, GitError, git, isShallow, SHALLOW_HINT } from "./git.js";
import { MAX_READ_BYTES, WorkingTree } from "./working-tree.js";

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
const SEARCH_RESULT_LIMIT = 100;
const SEARCH_OUTPUT_BYTES = 4 * 1024 * 1024;

// Explicit prefixes and flags keep the output parseable whatever the user's
// diff configuration (noprefix, mnemonicPrefix, external drivers, relative).
// Files over the threshold diff as binary, so one generated or vendored
// monster cannot fill memory before selection excludes it.
const DIFF_ARGS = [
  "-c",
  "core.quotepath=true",
  "-c",
  "core.bigFileThreshold=1m",
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
  private workingTree: WorkingTree | undefined;

  private readonly options: LocalGitOptions;

  constructor(options: LocalGitOptions) {
    this.options = options;
  }

  async repositoryRoot(): Promise<string> {
    return (await this.target()).root;
  }

  async getChangeRequest(): Promise<ChangeRequest> {
    return (await this.target()).request;
  }

  async getDiff(): Promise<FileDiff[]> {
    const { root, base, head } = await this.target();
    if (head !== undefined) {
      const attributes = await attributesFrom(root, base);
      return parseUnifiedDiff(
        await git([...attributes, ...DIFF_ARGS, base, head, "--"], { cwd: root }),
      );
    }
    return parseUnifiedDiff(await workspaceDiff(root, base));
  }

  async readFile(path: string): Promise<string | undefined> {
    const { root, head } = await this.target();
    const inside = relativeInside(root, resolve(root, path));
    if (inside === undefined) return undefined;

    if (head === undefined) {
      this.workingTree ??= new WorkingTree(root);
      return this.workingTree.read(inside);
    }

    try {
      return await git(["cat-file", "blob", `${head}:${inside.split(sep).join("/")}`], {
        cwd: root,
        truncateAt: MAX_READ_BYTES,
      });
    } catch (error) {
      if (error instanceof GitError && error.exitCode === 128) return undefined;
      throw error;
    }
  }

  async searchCode(literal: string): Promise<CodeMatch[]> {
    const { root, base, head } = await this.target();
    const attributes = head === undefined ? [] : await attributesFrom(root, base);
    const args = [
      ...attributes,
      "grep",
      "-n",
      "-z",
      "-I",
      "--no-color",
      "--full-name",
      "-F",
      "-m",
      "20",
    ];
    if (head === undefined) args.push("--untracked");
    args.push("-e", literal);
    if (head !== undefined) args.push(head);
    const out = await git([...args, "--"], {
      cwd: root,
      okExitCodes: [0, 1],
      truncateAt: SEARCH_OUTPUT_BYTES,
    });
    const prefix = head === undefined ? "" : `${head}:`;
    const lines = out.split("\n");
    // Output cut at the byte cap ends inside a line.
    if (!out.endsWith("\n")) lines.pop();
    return lines
      .filter((line) => line !== "")
      .slice(0, SEARCH_RESULT_LIMIT)
      .map((line) => {
        const [path = "", lineNumber = "0", ...text] = line.split("\0");
        return { path: path.slice(prefix.length), line: Number(lineNumber), text: text.join("\0") };
      });
  }

  async remoteUrl(remote: string): Promise<string> {
    const { root } = await this.target();
    return (await git(["remote", "get-url", "--end-of-options", remote], { cwd: root })).trim();
  }

  async getPriorReview(): Promise<PriorReview | undefined> {
    return undefined;
  }

  async publish(): Promise<{ warnings: string[] }> {
    return { warnings: [] };
  }

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
      const base = await mergeBase(root, from, to);
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
}

// Untracked files join the diff through intent-to-add entries in a throwaway
// copy of the index: one git process for any number of files, and the
// user's real index is never touched.
async function workspaceDiff(root: string, base: string): Promise<string> {
  const listing = await git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: root });
  const untracked = listing.split("\0").filter((p) => p !== "");
  if (untracked.length === 0) return git([...DIFF_ARGS, base, "--"], { cwd: root });

  const dir = await mkdtemp(join(tmpdir(), "ocra-index-"));
  try {
    const index = join(dir, "index");
    const realIndex = (await git(["rev-parse", "--git-path", "index"], { cwd: root })).trim();
    // The copy keeps the index's timestamp: git compares it with entry
    // timestamps to catch same-second, same-size edits ("racy git"), and a
    // fresh timestamp would make it trust stale stat data and miss them.
    await cp(resolve(root, realIndex), index, { preserveTimestamps: true }).catch(
      (error: unknown) => {
        if (!isNotFound(error)) throw error;
      },
    );
    const env = { GIT_INDEX_FILE: index, GIT_LITERAL_PATHSPECS: "1" };
    await git(["add", "--intent-to-add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      cwd: root,
      env,
      input: untracked.join("\0"),
    });
    return await git([...DIFF_ARGS, base, "--"], { cwd: root, env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function mergeBase(root: string, from: string, to: string): Promise<string> {
  try {
    return (await git(["merge-base", from, to], { cwd: root })).trim();
  } catch (error) {
    if (error instanceof GitError && (await isShallow(root))) {
      throw new OcraError(
        "VCS_GIT_FAILED",
        `Cannot find where ${from.slice(0, 7)} and ${to.slice(0, 7)} diverge: ${SHALLOW_HINT}`,
      );
    }
    throw error;
  }
}

function relativeInside(root: string, absolute: string): string | undefined {
  const inside = relative(root, absolute);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    return undefined;
  }
  return inside;
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
  if (sha === undefined) throw new OcraError("VCS_REF_UNKNOWN", `Unknown commit: ${ref}`);
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
