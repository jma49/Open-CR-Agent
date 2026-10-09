import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errnoCode } from "@open-cr-agent/core/internal";

// Files only this user may read (the ocra Cloud session, the salts, the
// session key), written
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
async function createPrivateFile(path: string, text: string): Promise<boolean> {
  const temp = await writeTemp(path, text);
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if (errnoCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * A random secret of this machine's user (32 bytes as hex) kept in the file,
 * made on first use. Two first uses at once agree on the one made first; a
 * file that holds no such secret is replaced.
 */
export async function machineSecret(path: string): Promise<string> {
  const existing = await readSecret(path);
  if (existing !== "unreadable") {
    if (existing) return existing;
    const fresh = randomBytes(32).toString("hex");
    if (await createPrivateFile(path, `${fresh}\n`)) return fresh;
    const made = await readSecret(path);
    if (made && made !== "unreadable") return made;
  }
  const fresh = randomBytes(32).toString("hex");
  await writePrivateFile(path, `${fresh}\n`);
  return fresh;
}

async function readSecret(path: string): Promise<string | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  const secret = text.trim();
  return /^[0-9a-f]{64}$/.test(secret) ? secret : "unreadable";
}

async function writeTemp(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  // "wx": a fresh file, so the mode applies; never one that already exists.
  await writeFile(temp, text, { mode: 0o600, flag: "wx" });
  return temp;
}
