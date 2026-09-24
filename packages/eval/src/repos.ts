import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Instance } from "./dataset.js";
import { exec } from "./exec.js";

const HOUR = 60 * 60_000;

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
      {
        timeoutMs: HOUR,
      },
    );
    if (clone.exitCode !== 0)
      throw new Error(`git clone ${instance.repo} failed: ${clone.stderr.trim()}`);
  }
  for (const commit of [instance.baseCommit, instance.headCommit]) {
    await ensureCommit(dir, commit, instance.prUrl);
  }
  const checkout = await exec(
    "git",
    ["checkout", "--quiet", "--force", "--detach", instance.headCommit],
    {
      cwd: dir,
      timeoutMs: HOUR,
    },
  );
  if (checkout.exitCode !== 0)
    throw new Error(`git checkout ${instance.headCommit} failed: ${checkout.stderr.trim()}`);
  return dir;
}

async function ensureCommit(dir: string, commit: string, prUrl: string): Promise<void> {
  if (await hasCommit(dir, commit)) return;
  await exec("git", ["fetch", "--quiet", "origin", commit], { cwd: dir, timeoutMs: HOUR });
  if (await hasCommit(dir, commit)) return;
  const pr = /\/pull\/(\d+)/.exec(prUrl)?.[1];
  if (pr)
    await exec("git", ["fetch", "--quiet", "origin", `pull/${pr}/head`], {
      cwd: dir,
      timeoutMs: HOUR,
    });
  if (!(await hasCommit(dir, commit)))
    throw new Error(`commit ${commit} is not available from ${prUrl}`);
}

async function hasCommit(dir: string, commit: string): Promise<boolean> {
  return (await exec("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: dir })).exitCode === 0;
}
