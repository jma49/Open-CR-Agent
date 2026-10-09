import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { errnoCode } from "@open-cr-agent/core/internal";

// A lock between ocra processes on one machine: a file created exclusively,
// holding when it was taken and by which process. Its times are the wall
// clock's, the one clock all processes share.

export type LockTiming = {
  /**
   * How long to wait for another holder before going on without the lock;
   * longer than staleMs, so that a dead holder's lock is broken first.
   */
  waitMs: number;
  /** A lock older than this was left by a process that died: longer than any holder holds it. */
  staleMs: number;
  /** How long a wait lasts before the waiter is told. */
  noticeMs: number;
  pollMs: number;
};

/** A lock found at the path: what tells it from a later one, when it was taken, and by whom. */
type Held = { key: string; at: number; pid?: unknown; host?: unknown };

const HOST = hostname();

/**
 * Runs `fn` holding the lock at `path`. When it cannot be had within
 * `waitMs`, `fn` runs anyway: the lock only narrows races its callers must
 * still survive, and a stuck holder must not stop a review. `onLongWait`
 * hears once that the wait has passed `noticeMs`.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  timing: LockTiming,
  onLongWait?: () => void,
): Promise<T> {
  const held = await acquire(path, timing, onLongWait);
  try {
    return await fn();
  } finally {
    // Broken as stale and taken by another meanwhile: theirs now, left alone.
    if (held !== undefined) await removeLock(path, held, timing);
  }
}

/** The text of the lock this process made; undefined when it goes on without one. */
async function acquire(
  path: string,
  timing: LockTiming,
  onLongWait: (() => void) | undefined,
): Promise<string | undefined> {
  const token = randomBytes(8).toString("hex");
  const started = Date.now();
  let told = false;
  for (;;) {
    const mine = JSON.stringify({ token, at: Date.now(), pid: process.pid, host: HOST });
    let found: "lock" | "removing";
    try {
      await writeFile(path, mine, { flag: "wx", mode: 0o600 });
      return mine;
    } catch (error) {
      const how = await whyNotMade(path, errnoCode(error), timing);
      // A lock that cannot be made at all (a read-only directory) is no lock.
      if (how === undefined) return undefined;
      found = how;
    }
    if (found === "lock") {
      const held = await readLock(path);
      if (held === undefined) continue;
      if (isStale(held, timing) && (await removeLock(path, held.key, timing))) continue;
    }
    const waited = Date.now() - started;
    if (waited >= timing.waitMs) return undefined;
    if (!told && waited >= timing.noticeMs) {
      told = true;
      onLongWait?.();
    }
    await sleep(timing.pollMs);
  }
}

/**
 * Why the lock file could not be made: another lock is there, or one is
 * being removed; undefined when no lock can be made there at all. Windows
 * keeps a removed file while a handle to it is open (another process
 * reading it) and refuses to create it again with EPERM until then, where
 * the file itself can no longer be seen (lstat fails with EPERM too). Found
 * absent, it was either removed in full since the refusal or never there,
 * in a directory that takes no new file: a file of a name no one else uses
 * tells which.
 */
async function whyNotMade(
  path: string,
  code: string | undefined,
  timing: LockTiming,
): Promise<"lock" | "removing" | undefined> {
  if (code === "EEXIST") return "lock";
  if (process.platform !== "win32" || code !== "EPERM") return undefined;
  const seen = await lstat(path).then(
    () => "lock" as const,
    (error: unknown) =>
      errnoCode(error) === "ENOENT" ? ("absent" as const) : ("removing" as const),
  );
  if (seen !== "absent") return seen;
  return (await canCreateBeside(path, timing)) ? "removing" : undefined;
}

async function canCreateBeside(path: string, timing: LockTiming): Promise<boolean> {
  const probe = `${path}.${randomBytes(8).toString("hex")}.probe`;
  try {
    await writeFile(probe, "", { flag: "wx", mode: 0o600 });
  } catch {
    return false;
  }
  await rm(probe, { force: true }).catch(() => {});
  await removeStaleProbes(path, timing);
  return true;
}

const PROBE_SUFFIX = /^\.[0-9a-f]{16}\.probe$/;

/** Probes left by a process that died between making and removing one; each later probe sweeps them. */
async function removeStaleProbes(path: string, timing: LockTiming): Promise<void> {
  const lock = basename(path);
  const names = await readdir(dirname(path)).catch(() => []);
  for (const name of names) {
    if (!name.startsWith(lock) || !PROBE_SUFFIX.test(name.slice(lock.length))) continue;
    const probe = `${path}${name.slice(lock.length)}`;
    const left = await lstat(probe).catch(() => undefined);
    if (left?.isFile() && Math.abs(Date.now() - left.mtimeMs) > timing.staleMs) {
      await rm(probe, { force: true }).catch(() => {});
    }
  }
}

/** The lock at `path`; undefined when it is gone. */
async function readLock(path: string): Promise<Held | undefined> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  if (text !== undefined) {
    try {
      const lock = JSON.parse(text) as { at?: unknown; pid?: unknown; host?: unknown };
      if (typeof lock.at === "number") {
        return { key: text, at: lock.at, pid: lock.pid, host: lock.host };
      }
    } catch {}
  }
  // Being written, unreadable, or not a lock of ours: the file's own entry stands in.
  const entry = await lstat(path).catch(() => undefined);
  if (!entry) return undefined;
  return { key: text ?? `${entry.ino}:${entry.mtimeMs}:${entry.size}`, at: entry.mtimeMs };
}

function isStale(held: Held, timing: LockTiming): boolean {
  // A clock set back leaves a lock dated ahead: as dead as an old one.
  return Math.abs(Date.now() - held.at) > timing.staleMs || holderExited(held);
}

/** False when not known: taken on another machine, or its number reused by a running process. */
function holderExited({ pid, host }: Held): boolean {
  if (host !== HOST || typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errnoCode(error) === "ESRCH";
  }
}

/**
 * Removes the lock at `path` if it is still the one `key` names; true only
 * when it did. Removers of one lock take turns through a claim named after
 * it: checked and removed by two at once, the later removal could take the
 * lock a third process made in between.
 */
async function removeLock(path: string, key: string, timing: LockTiming): Promise<boolean> {
  const claim = `${path}.${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  try {
    await writeFile(claim, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") return false;
    // Left by a process that died removing the lock.
    const left = await lstat(claim).catch(() => undefined);
    if (left && Math.abs(Date.now() - left.mtimeMs) > timing.staleMs) {
      await rm(claim, { force: true }).catch(() => {});
    }
    return false;
  }
  try {
    if ((await readLock(path))?.key !== key) return false;
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    await rm(claim, { force: true }).catch(() => {});
  }
}
