import { OcraError } from "@open-cr-agent/core";
import { credentialEnvironment, git, isShallow } from "./git.js";

const FETCH_TIMEOUT_MS = 2 * 60_000;
const BRANCH = /^refs\/heads\/([A-Za-z0-9._/-]+)$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

interface RemoteBranch {
  name: string;
  sha: string;
}

// The remote's branches whose names start with `prefix`, last name first
// and at most `max`, with their commits fetched so they can be read. No
// local ref is written: the commits are reachable only for this run.
export async function fetchRemoteBranches(
  root: string,
  prefix: string,
  { max, remote = "origin" }: { max: number; remote?: string },
): Promise<RemoteBranch[]> {
  if (!/^[A-Za-z0-9._-][A-Za-z0-9._/-]*$/.test(prefix) || prefix.includes("..")) {
    throw new OcraError("INPUT_INVALID", `Not a branch name prefix: ${prefix}`);
  }
  // No credential prompt can block a non-interactive run.
  const env = { ...credentialEnvironment(process.env), GIT_TERMINAL_PROMPT: "0" };
  const listed = await git(["ls-remote", "--heads", remote, `refs/heads/${prefix}*`], {
    cwd: root,
    timeoutMs: FETCH_TIMEOUT_MS,
    env,
  });
  const branches = listed
    .split("\n")
    .map((line) => {
      const [sha = "", ref = ""] = line.split("\t");
      const name = BRANCH.exec(ref)?.[1];
      return name?.startsWith(prefix) && SHA.test(sha) && !name.includes("..")
        ? { name, sha }
        : undefined;
    })
    .filter((b) => b !== undefined)
    .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    .slice(0, max);
  const absent = await missing(root, branches);
  if (absent.length > 0) {
    // Fetching full history into a shallow clone would undo its depth.
    const depth = (await isShallow(root)) ? ["--depth=1"] : [];
    // An empty refmap keeps git from updating origin's tracking refs.
    await git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--refmap=",
        ...depth,
        remote,
        ...absent.map((b) => `refs/heads/${b.name}`),
      ],
      { cwd: root, timeoutMs: FETCH_TIMEOUT_MS, env },
    );
  }
  const unread = new Set(await missing(root, branches));
  return branches.filter((b) => !unread.has(b));
}

async function missing(root: string, branches: readonly RemoteBranch[]): Promise<RemoteBranch[]> {
  if (branches.length === 0) return [];
  const out = await git(["cat-file", "--batch-check=%(objecttype)"], {
    cwd: root,
    input: `${branches.map((b) => b.sha).join("\n")}\n`,
  });
  const types = out.split("\n");
  return branches.filter((_, i) => types[i] !== "commit");
}
