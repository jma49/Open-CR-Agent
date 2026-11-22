import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { OcraError } from "@open-cr-agent/core";

const run = promisify(execFile);
const TIMEOUT_MS = 300_000;
const MAX_OUTPUT = 16 * 1024 * 1024;

// The author's own clone: git runs with their environment, so a push uses
// their credentials.
export class StackGit {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async run(args: readonly string[]): Promise<string> {
    try {
      const { stdout } = await run("git", [...args], {
        cwd: this.cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT,
      });
      return stdout.trim();
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new OcraError("VCS_GIT_FAILED", stderr || `git ${args[0]} failed`);
    }
  }

  async succeeds(args: readonly string[]): Promise<boolean> {
    return this.run(args).then(
      () => true,
      () => false,
    );
  }

  async currentBranch(): Promise<string> {
    const branch = await this.run(["branch", "--show-current"]);
    if (!branch)
      throw new OcraError("INPUT_USAGE", "ocra stack works on a branch; HEAD is detached");
    return branch;
  }

  commit(ref: string): Promise<string> {
    return this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  }

  async resolves(ref: string): Promise<boolean> {
    return this.commit(ref).then(
      () => true,
      () => false,
    );
  }

  isAncestor(ancestor: string, of: string): Promise<boolean> {
    return this.succeeds(["merge-base", "--is-ancestor", ancestor, of]);
  }

  async checkBranchName(name: string): Promise<string> {
    if (name.startsWith("-") || !(await this.succeeds(["check-ref-format", "--branch", name]))) {
      throw new OcraError("INPUT_USAGE", `Not a valid branch name: ${JSON.stringify(name)}`);
    }
    return name;
  }

  async trunk(): Promise<string> {
    const head = await this.run([
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]).catch(() => "");
    return head.startsWith("origin/") ? head.slice("origin/".length) : "main";
  }

  // What a branch on the trunk is rebased onto: origin's trunk when there
  // is one, so restack and sync agree on it.
  async trunkRef(trunk: string): Promise<string> {
    const remote = `refs/remotes/origin/${trunk}`;
    return (await this.resolves(remote)) ? remote : `refs/heads/${trunk}`;
  }

  async assertNoRebase(): Promise<void> {
    for (const state of ["rebase-merge", "rebase-apply"]) {
      const path = await this.run(["rev-parse", "--path-format=absolute", "--git-path", state]);
      if (existsSync(path)) {
        throw new OcraError(
          "INPUT_USAGE",
          "A rebase is in progress: finish it (git rebase --continue) or abort it first",
        );
      }
    }
  }

  async assertClean(): Promise<void> {
    await this.assertNoRebase();
    if (await this.run(["status", "--porcelain", "--untracked-files=no"])) {
      throw new OcraError("INPUT_USAGE", "Commit or stash your changes first");
    }
  }
}
