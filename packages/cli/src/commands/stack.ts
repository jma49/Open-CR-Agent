import { parseArgs } from "node:util";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { UsageError } from "../io/usage-error.js";
import type { ProposalPlace } from "./platform-place.js";
import type { ReviewDeps } from "./review/deps.js";
import { StackGit } from "./stack/git.js";
import { stackHost } from "./stack/host.js";
import { readLinks, writeLink } from "./stack/links.js";
import { restack } from "./stack/restack.js";
import { submit } from "./stack/submit.js";
import { sync } from "./stack/sync.js";
import { depthOf, stackOf } from "./stack/tree.js";

export const STACK_USAGE = `Usage: ocra stack <command> [options]

Keeps a stack of branches, each a pull or merge request based on the one
below it. The stack lives in this clone's git config; the platform sees each
change request's base branch.

Commands:
  create <branch>   Branch from the current one and stack it on it
  track [<parent>]  Stack the current branch on <parent> (default: the trunk)
  log               Show the stack the current branch is in
  restack           Rebase each branch onto its parent's tip, bottom to top
  submit            Push every branch and open or update its change request
  sync              Fetch, fold in what merged, delete it, and restack

Options:
  -m, --message <text> create: commit what is staged with this message
  --draft              submit: open new change requests as drafts
  --repo <owner/name>  The GitHub repository (default: GITHUB_REPOSITORY or origin)
  --project <id|path>  The GitLab project (default: CI_PROJECT_ID or origin)
  -h, --help           Show help

submit and sync need GITHUB_TOKEN (or GH_TOKEN) or GITLAB_TOKEN.
`;

interface StackIo {
  out: Output;
  err: Output;
}

export async function stackCommand(
  argv: string[],
  io: StackIo,
  deps: Pick<ReviewDeps, "cwd" | "env" | "fetch">,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      message: { type: "string", short: "m" },
      draft: { type: "boolean" },
      repo: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.out.write(STACK_USAGE);
    return EXIT.ok;
  }
  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError("");
  const git = new StackGit(deps.cwd);
  const root = await git.run(["rev-parse", "--show-toplevel"]);
  await git.assertNoRebase();
  const trunk = await git.trunk();
  const place = placeOf(values);
  const host = () => stackHost(root, place, deps, (m) => io.err.write(`warning: ${m}\n`));
  const tooMany = (n: number) => {
    if (rest.length > n) throw new UsageError(`Too many arguments for ocra stack ${command}`);
  };

  if (command === "create") {
    tooMany(1);
    const name = rest[0];
    if (!name) throw new UsageError("ocra stack create needs a branch name");
    const branch = await git.checkBranchName(name);
    const parent = await git.currentBranch();
    const parentHead = await git.commit("HEAD");
    await git.run(["switch", "--quiet", "-c", branch]);
    if (values.message !== undefined) await git.run(["commit", "--quiet", "-m", values.message]);
    await writeLink(git, branch, { parent, parentHead });
    io.out.write(`${branch} is stacked on ${parent}\n`);
    return EXIT.ok;
  }
  if (command === "track") {
    tooMany(1);
    const branch = await git.currentBranch();
    const parent = await git.checkBranchName(rest[0] ?? trunk);
    if (parent === branch) throw new UsageError("A branch cannot be stacked on itself");
    const onto = parent === trunk ? await git.trunkRef(trunk) : `refs/heads/${parent}`;
    const parentHead = await git.run(["merge-base", onto, "HEAD"]);
    await writeLink(git, branch, { parent, parentHead });
    io.out.write(`${branch} is stacked on ${parent}\n`);
    return EXIT.ok;
  }

  tooMany(0);
  const branch = await git.currentBranch();
  const links = await readLinks(git);
  const order = stackOf(links, branch);
  if (order.length === 0) {
    throw new UsageError(`${branch} is in no stack; start one with ocra stack create`);
  }
  if (command === "log") {
    io.out.write(`${trunk}\n`);
    for (const b of order) {
      const parent = links.get(b)?.parent ?? trunk;
      const tip = parent === trunk ? await git.trunkRef(trunk) : `refs/heads/${parent}`;
      const behind = !(await git.isAncestor(tip, `refs/heads/${b}`));
      const marks = [b === branch ? "(current)" : "", behind ? "(needs restack)" : ""];
      io.out.write(
        `${"  ".repeat(depthOf(links, b) + 1)}${[b, ...marks].filter(Boolean).join(" ")}\n`,
      );
    }
    return EXIT.ok;
  }
  if (command === "restack") {
    const { moved } = await restack(git, links, order, trunk);
    io.out.write(
      moved.length > 0 ? `Restacked ${moved.join(", ")}\n` : "Every branch is on its parent\n",
    );
    return EXIT.ok;
  }
  if (command === "submit") {
    const submitted = await submit(git, await host(), links, order, {
      trunk,
      draft: values.draft === true,
    });
    for (const s of submitted) io.out.write(`${s.branch}  ${s.action}  ${s.webUrl}\n`);
    return EXIT.ok;
  }
  if (command === "sync") {
    const { merged, moved } = await sync(git, await host(), branch, trunk);
    io.out.write(
      merged.length > 0 ? `Merged and deleted: ${merged.join(", ")}\n` : "Nothing merged\n",
    );
    if (moved.length > 0)
      io.out.write(`Restacked ${moved.join(", ")}; ocra stack submit pushes them\n`);
    return EXIT.ok;
  }
  throw new UsageError(`Unknown stack command: ${command}`);
}

function placeOf(values: { repo?: string; project?: string }): ProposalPlace | undefined {
  if (values.repo !== undefined && values.project !== undefined) {
    throw new UsageError("--repo is GitHub's and --project GitLab's: pass one");
  }
  if (values.repo !== undefined) return { platform: "github", repository: values.repo };
  if (values.project !== undefined) return { platform: "gitlab", repository: values.project };
  return undefined;
}
