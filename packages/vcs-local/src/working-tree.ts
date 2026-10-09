import type { Dirent } from "node:fs";
import { lstat, open, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { errnoCode } from "@open-cr-agent/core/internal";

// A run keeps every file it reads in memory; files beyond this are read in
// part (larger ones are diffed as binary and not reviewed anyway).
export const MAX_READ_BYTES = 2 * 1024 * 1024;

// Reads what git would store, as range and commit mode do: a symlink reads as
// its target path, a path through a symlinked directory does not exist, and
// neither does another spelling of a file's name. Following links would let a
// committed `notes.txt -> .env` read a file the core access policy refuses by
// name; so would a spelling that a case-insensitive file system folds to it.
//
// Each directory is listed once per run: a review reads many files of the
// same directories, and listing a large one takes hundreds of milliseconds.
export class WorkingTree {
  private readonly root: string;
  private realRoot: Promise<string> | undefined;
  private readonly listings = new Map<string, Promise<Dirent[]>>();

  constructor(root: string) {
    this.root = root;
  }

  // `inside` is relative to the root and inside it.
  async read(inside: string): Promise<string | undefined> {
    try {
      this.realRoot ??= realpath(this.root);
      const path = await this.locate(await this.realRoot, inside.split(sep));
      if (path === undefined) return undefined;
      return await readListed(path);
    } catch (error) {
      const code = errnoCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return undefined;
      throw error;
    }
  }

  // The path under the names the directories list, or undefined when a part
  // is not listed or the parent is reached through a link.
  private async locate(realRoot: string, parts: readonly string[]): Promise<string | undefined> {
    let dir = realRoot;
    for (const [i, part] of parts.entries()) {
      const entry = await this.listed(dir, part);
      if (entry === undefined) return undefined;
      const last = i === parts.length - 1;
      if (!last && !entry.isDirectory()) return undefined;
      dir = join(dir, entry.name);
    }
    // A directory the listing reports as one can still be a junction or a
    // mount; the parent's real path must be the one walked.
    const parent = join(dir, "..");
    return (await realpath(parent)) === parent ? dir : undefined;
  }

  // Up to Unicode normalization: git on macOS reports names precomposed,
  // whatever their form on disk.
  private async listed(dir: string, name: string): Promise<Dirent | undefined> {
    const entries = await this.list(dir);
    const exact = entries.find((entry) => entry.name === name);
    if (exact) return exact;
    const wanted = name.normalize("NFC");
    return entries.find((entry) => entry.name.normalize("NFC") === wanted);
  }

  private list(dir: string): Promise<Dirent[]> {
    let listing = this.listings.get(dir);
    if (listing === undefined) {
      listing = readdir(dir, { withFileTypes: true });
      // A failure other than absence (too many open files) may pass.
      listing.catch(() => this.listings.delete(dir));
      this.listings.set(dir, listing);
    }
    return listing;
  }
}

async function readListed(path: string): Promise<string | undefined> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return await readlink(path, "utf8");
  if (!stat.isFile()) return undefined;
  if (stat.size <= MAX_READ_BYTES) return await readFile(path, "utf8");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, MAX_READ_BYTES, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
