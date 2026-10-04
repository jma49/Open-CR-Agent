import { randomBytes } from "node:crypto";
import { link, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Files only this user may read (the ocra Cloud session, the salts), written
// so that no reader, another ocra process included, ever sees one half
// written: the text goes to a temporary file in the same directory, created
// 0600, which then replaces the file in one rename.

/** Writes the file atomically, readable only by this user. */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const temp = await writeTemp(path, text);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * Writes the file atomically unless it exists: false when another writer
 * made it first, whose content then stands.
 */
export async function createPrivateFile(path: string, text: string): Promise<boolean> {
  const temp = await writeTemp(path, text);
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

async function writeTemp(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  // "wx": a fresh file, so the mode applies; never one that already exists.
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  return temp;
}
