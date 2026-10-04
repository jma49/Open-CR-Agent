import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ScratchRepo {
  dir: string;
  // Runs git in the repository; its output, trimmed.
  git(...args: string[]): string;
  // Writes a file, creating its directories.
  write(path: string, content: string): void;
  // Writes the files, stages everything and commits; the new commit's id.
  commit(message: string, files?: Record<string, string>): string;
}

export interface ScratchRepoOptions {
  // The temporary directory's name prefix.
  prefix?: string;
  // A remote named origin with this URL.
  origin?: string;
}

// A git repository in a new temporary directory, on branch main, with a
// fixed identity and no commit signing, whatever the host's git config says
// (init.defaultBranch, user.*, commit.gpgsign). The caller removes `dir`.
export function scratchRepo({
  prefix = "ocra-repo-",
  origin,
}: ScratchRepoOptions = {}): ScratchRepo {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  if (origin !== undefined) git("remote", "add", "origin", origin);
  const write = (path: string, content: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  };
  const commit = (message: string, files: Record<string, string> = {}) => {
    for (const [path, content] of Object.entries(files)) write(path, content);
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  return { dir, git, write, commit };
}

// Scratch repositories a test file makes and removes together: call
// removeAll from afterEach (or afterAll).
export function scratchRepos(prefix = "ocra-repo-"): {
  create(options?: Omit<ScratchRepoOptions, "prefix">): ScratchRepo;
  removeAll(): void;
} {
  const dirs: string[] = [];
  return {
    create(options = {}) {
      const repo = scratchRepo({ ...options, prefix });
      dirs.push(repo.dir);
      return repo;
    },
    removeAll() {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
