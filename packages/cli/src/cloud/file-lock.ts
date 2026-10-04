import { randomBytes } from "node:crypto";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { errnoCode, isNotFound } from "@open-cr-agent/core/internal";

// A lock between ocra processes on one machine: a file created exclusively,
// holding when it was taken. Its times are the wall clock's, the one clock
// all processes share.

export type LockTiming = {
  /** How long to wait for another holder before going on without the lock. */
  waitMs: number;
  /** A lock older than this was left by a process that died holding it. */
  staleMs: number;
  pollMs: number;
};

const TIMING: LockTiming = { waitMs: 10_000, staleMs: 30_000, pollMs: 50 };

/**
 * Runs `fn` holding the lock at `path`. When it cannot be had within
 * `waitMs`, `fn` runs anyway: the lock only narrows races its callers must
 * still survive, and a stuck holder must not stop a review.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  timing: LockTiming = TIMING,
): Promise<T> {
  const token = await acquire(path, timing);
  try {
    return await fn();
  } finally {
    if (token) await release(path, token);
  }
}

async function acquire(path: string, timing: LockTiming): Promise<string | undefined> {
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + timing.waitMs;
  for (;;) {
    try {
      await writeFile(path, JSON.stringify({ token, at: Date.now(), pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
      return token;
    } catch (error) {
      // A lock that cannot be made at all (a read-only directory) is no lock.
      if (errnoCode(error) !== "EEXIST") return undefined;
    }
    const age = await ageOf(path);
    if (age === undefined) continue;
    if (age > timing.staleMs) {
      await rm(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(timing.pollMs);
  }
}

/** Milliseconds since the lock was taken; undefined when it is gone. */
async function ageOf(path: string): Promise<number | undefined> {
  try {
    const at = (JSON.parse(await readFile(path, "utf8")) as { at?: unknown }).at;
    if (typeof at === "number") return Date.now() - at;
  } catch (error) {
    if (isNotFound(error)) return undefined;
  }
  // Being written, or not a lock of ours: its file's own time stands in.
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

async function release(path: string, token: string): Promise<void> {
  try {
    const held = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
    // Broken as stale and taken by another: theirs now.
    if (held.token === token) await rm(path, { force: true });
  } catch {}
}
