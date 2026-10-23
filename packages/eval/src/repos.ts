import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "./exec.js";
import type { Instance } from "./instance.js";

const HOUR = 60 * 60_000;

// Reviews read source, not LFS media, so checkouts keep the pointer files.
// Skipping the smudge is not enough when a global or repository config
// declares the LFS filter but git-lfs is not installed: the filter process
// then fails to start. Marking the filter optional lets git fall back to the
// raw content for every call (config passed through the environment).
// Older git (2.43, Ubuntu 24.04) still dies when the declared process filter
// cannot start, so the process filter is also blanked and the smudge filter
// replaced with a pass-through.
export const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "filter.lfs.required",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "filter.lfs.process",
  GIT_CONFIG_VALUE_1: "",
  GIT_CONFIG_KEY_2: "filter.lfs.smudge",
  GIT_CONFIG_VALUE_2: "cat",
};

// Blobless clones keep the full commit graph (needed for merge-base) without
// every historical file version; checking out the head commit then fetches its
// snapshot in one batch, so code search at that commit does not download blobs
// one at a time.
export async function prepareRepository(reposDir: string, instance: Instance): Promise<string> {
  const dir = join(reposDir, instance.repo.replace("/", "__"));
  if (!existsSync(join(dir, ".git"))) {
    await mkdir(reposDir, { recursive: true });
    const clone = await exec(
      "git",
      [
        "clone",
        "--filter=blob:none",
        "--no-checkout",
        "--quiet",
        `https://github.com/${instance.repo}.git`,
        dir,
      ],
      { timeoutMs: HOUR, env: GIT_ENV },
    );
    if (clone.exitCode !== 0)
      throw new Error(`git clone ${instance.repo} failed: ${clone.stderr.trim()}`);
  }
  for (const commit of [instance.baseCommit, instance.headCommit]) {
    await ensureCommit(dir, commit, instance.prUrl);
  }
  const checkout = await exec("git", checkoutArgs(instance.headCommit), {
    cwd: dir,
    timeoutMs: HOUR,
    env: GIT_ENV,
  });
  if (checkout.exitCode !== 0)
    throw new Error(`git checkout ${instance.headCommit} failed: ${checkout.stderr.trim()}`);
  return dir;
}

// No --end-of-options: git 2.43 (Ubuntu 24.04) rejects it after --detach
// ("--detach does not take a path argument"). The commit is safe as the
// last argument because the dataset admits only hexadecimal commit ids.
export function checkoutArgs(commit: string): string[] {
  return ["checkout", "--quiet", "--force", "--detach", commit];
}

// Some PR commits in the dataset were force-pushed away and are no longer
// fetchable; those PRs are a dataset problem, not a review failure.
export class UnavailableCommitError extends Error {}

async function ensureCommit(dir: string, commit: string, prUrl: string): Promise<void> {
  if (await hasCommit(dir, commit)) return;
  await exec("git", ["fetch", "--quiet", "--end-of-options", "origin", commit], {
    cwd: dir,
    timeoutMs: HOUR,
    env: GIT_ENV,
  });
  if (await hasCommit(dir, commit)) return;
  const pr = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (pr)
    await exec("git", ["fetch", "--quiet", "origin", `pull/${pr}/head`], {
      cwd: dir,
      timeoutMs: HOUR,
    });
  if (!(await hasCommit(dir, commit)))
    throw new UnavailableCommitError(`commit ${commit} is not available from ${prUrl}`);
}

// A licence text runs to tens of kilobytes; a larger file is passed on empty
// rather than buffered, and reads as unrecognised.
const MAX_ROOT_FILE_BYTES = 1024 * 1024;
const MAX_ROOT_FILES = 16;

// The files at the root of a commit whose names `accept` takes, read from
// git's objects: no checkout, no filter, nothing from the repository runs.
export async function rootFiles(
  dir: string,
  commit: string,
  accept: (name: string) => boolean,
): Promise<{ name: string; text: string }[]> {
  const tree = await exec("git", ["ls-tree", "-z", "-l", "--end-of-options", commit], {
    cwd: dir,
    env: GIT_ENV,
  });
  if (tree.exitCode !== 0) throw new Error(`git ls-tree failed: ${tree.stderr.trim()}`);
  const blobs = tree.stdout.split("\0").flatMap((entry) => {
    const [, object, size, name] = /^\d+ blob ([0-9a-f]+) +(\d+)\t(.+)$/s.exec(entry) ?? [];
    return object && size && name && accept(name) ? [{ object, size: Number(size), name }] : [];
  });
  const files: { name: string; text: string }[] = [];
  for (const blob of blobs.slice(0, MAX_ROOT_FILES)) {
    if (blob.size > MAX_ROOT_FILE_BYTES) {
      files.push({ name: blob.name, text: "" });
      continue;
    }
    const read = await exec("git", ["cat-file", "blob", blob.object], { cwd: dir, env: GIT_ENV });
    if (read.exitCode !== 0) throw new Error(`git cat-file failed: ${read.stderr.trim()}`);
    files.push({ name: blob.name, text: read.stdout });
  }
  return files;
}

async function hasCommit(dir: string, commit: string): Promise<boolean> {
  return (await exec("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: dir })).exitCode === 0;
}
