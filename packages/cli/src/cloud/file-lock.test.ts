import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "ocra-lock-")), "x.lock");
const QUICK = { waitMs: 200, staleMs: 30_000, noticeMs: 10_000, pollMs: 10 };
const tokenAt = (path: string) =>
  (JSON.parse(readFileSync(path, "utf8")) as { token: string }).token;

/** The number of a process that has exited. */
const exitedPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;

/** Runs `contenders` holders at once on `path`; the most that were inside at one time. */
async function mostInside(path: string, contenders: number): Promise<number> {
  let inside = 0;
  let most = 0;
  await Promise.all(
    Array.from({ length: contenders }, () =>
      withFileLock(
        path,
        async () => {
          inside += 1;
          most = Math.max(most, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside -= 1;
        },
        { ...QUICK, waitMs: 5_000 },
      ),
    ),
  );
  return most;
}

describe("withFileLock", () => {
  it("runs one holder at a time and removes its lock", async () => {
    const path = lockPath();
    expect(await mostInside(path, 5)).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("goes on without the lock after waiting, and leaves the holder's lock alone", async () => {
    // A holder that is running, and one whose process number means nothing here.
    for (const holder of [
      { pid: process.pid, host: hostname() },
      { pid: exitedPid(), host: "another-machine" },
    ]) {
      const path = lockPath();
      const held = JSON.stringify({ token: "other", at: Date.now(), ...holder });
      writeFileSync(path, held);
      const started = Date.now();
      expect(await withFileLock(path, async () => "ran", QUICK)).toBe("ran");
      expect(Date.now() - started).toBeGreaterThanOrEqual(QUICK.waitMs);
      expect(readFileSync(path, "utf8")).toBe(held);
    }
  });

  it("says once that it is waiting, when the wait grows long", async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "other", at: Date.now() }));
    let told = 0;
    await withFileLock(
      path,
      async () => {},
      { ...QUICK, noticeMs: 50 },
      () => {
        told += 1;
      },
    );
    expect(told).toBe(1);
  });

  it("breaks at once the lock of a process that has exited", async () => {
    const path = lockPath();
    writeFileSync(
      path,
      JSON.stringify({ token: "gone", at: Date.now(), pid: exitedPid(), host: hostname() }),
    );
    const started = Date.now();
    await withFileLock(path, async () => expect(tokenAt(path)).not.toBe("gone"), QUICK);
    expect(Date.now() - started).toBeLessThan(QUICK.waitMs);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("breaks a stale lock it cannot read", async () => {
    const path = lockPath();
    writeFileSync(path, "not a lock");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(path, tenMinutesAgo, tenMinutesAgo);
    chmodSync(path, 0o000);
    const started = Date.now();
    await withFileLock(path, async () => expect(tokenAt(path)).toMatch(/^[0-9a-f]{16}$/), QUICK);
    expect(Date.now() - started).toBeLessThan(QUICK.waitMs);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("breaks a stale lock, and one dated ahead by a clock set back", async () => {
    for (const at of [Date.now() - 31_000, Date.now() + 31_000]) {
      const path = lockPath();
      writeFileSync(path, JSON.stringify({ token: "dead", at }));
      const started = Date.now();
      await withFileLock(path, async () => expect(tokenAt(path)).not.toBe("dead"), QUICK);
      expect(Date.now() - started).toBeLessThan(QUICK.waitMs);
      expect(readdirSync(dirname(path))).toEqual([]);
    }
  });

  it("lets one of several contenders at a time take a stale lock", async () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const path = lockPath();
      writeFileSync(path, JSON.stringify({ token: "dead", at: Date.now() - 31_000 }));
      expect(await mostInside(path, 8)).toBe(1);
      expect(readdirSync(dirname(path))).toEqual([]);
    }
  });

  it("releases the lock when the holder throws", async () => {
    const path = lockPath();
    await expect(
      withFileLock(
        path,
        async () => {
          throw new Error("boom");
        },
        QUICK,
      ),
    ).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });
});
