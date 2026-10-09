import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { errorMessage } from "@open-cr-agent/core";
import { errnoCode, isNotFound } from "@open-cr-agent/core/internal";

// Files only this user may read (the ocra Cloud session, the salts, the
// session key), written
// so that no reader, another ocra process included, ever sees one half
// written: the text goes to a temporary file in the same directory, created
// 0600 and flushed to disk, which then replaces the file in one rename. A
// crash right after cannot leave an empty file where the session was, which
// after the server rotated the refresh token would mean signing in again.

// Windows refuses a rename while another program (an antivirus or the
// indexer) has the file open for a moment; ~1.3 s in all before giving up.
const RENAME_RETRIES_MS = [10, 20, 40, 80, 160, 320, 640];
const HELD = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Writes the file atomically, readable only by this user. */
export async function writePrivateFile(path: string, text: string): Promise<void> {
  const temp = await writeTemp(path, text);
  try {
    await replace(temp, path);
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

/** The file holding a machine secret cannot be read, or none can be made. */
export class MachineSecretError extends Error {}

/**
 * A random secret of this machine's user (32 bytes as hex) kept in the file,
 * made on first use. Two first uses at once agree on the one made first; a
 * file that holds no such secret is replaced. One that cannot be read (owned
 * by another user, say, after `sudo ocra`) may hold the secret still in use,
 * so it is left as it is: MachineSecretError, as when no file can be written
 * (a read-only config directory).
 */
export async function machineSecret(path: string): Promise<string> {
  const existing = await readSecret(path);
  if (existing !== "invalid") {
    if (existing) return existing;
    const fresh = randomBytes(32).toString("hex");
    if (await made(path, () => createPrivateFile(path, `${fresh}\n`))) return fresh;
    const other = await readSecret(path);
    if (other && other !== "invalid") return other;
  }
  const fresh = randomBytes(32).toString("hex");
  await made(path, () => writePrivateFile(path, `${fresh}\n`));
  return fresh;
}

async function made<T>(path: string, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    throw new MachineSecretError(
      `${path} cannot be made (${errnoCode(error) ?? errorMessage(error)})`,
      { cause: error },
    );
  }
}

async function readSecret(path: string): Promise<string | "invalid" | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new MachineSecretError(
      `${path} cannot be read (${errnoCode(error) ?? errorMessage(error)}); it was left as it is`,
      { cause: error },
    );
  }
  const secret = text.trim();
  return /^[0-9a-f]{64}$/.test(secret) ? secret : "invalid";
}

async function writeTemp(path: string, text: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  // "wx": a fresh file, so the mode applies; never one that already exists.
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(temp, { force: true });
    throw error;
  }
  await file.close();
  return temp;
}

async function replace(temp: string, path: string): Promise<void> {
  for (const delayMs of process.platform === "win32" ? RENAME_RETRIES_MS : []) {
    try {
      await rename(temp, path);
      return;
    } catch (error) {
      if (!HELD.has(errnoCode(error) ?? "")) throw error;
      await wait(delayMs);
    }
  }
  await rename(temp, path);
}
