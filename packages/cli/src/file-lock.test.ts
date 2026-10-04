import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "ocra-lock-")), "x.lock");
const QUICK = { waitMs: 200, staleMs: 30_000, pollMs: 10 };

describe("withFileLock", () => {
  it("runs one holder at a time and removes its lock", async () => {
    const path = lockPath();
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 5 }, () =>
        withFileLock(path, async () => {
          inside += 1;
          most = Math.max(most, inside);
          await new Promise((resolve) => setTimeout(resolve, 10));
          inside -= 1;
        }),
      ),
    );
    expect(most).toBe(1);
    expect(existsSync(path)).toBe(false);
  });

  it("goes on without the lock after waiting, and leaves the holder's lock alone", async () => {
    const path = lockPath();
    const held = JSON.stringify({ token: "other", at: Date.now() });
    writeFileSync(path, held);
    const started = Date.now();
    expect(await withFileLock(path, async () => "ran", QUICK)).toBe("ran");
    expect(Date.now() - started).toBeGreaterThanOrEqual(QUICK.waitMs);
    expect(readFileSync(path, "utf8")).toBe(held);
  });

  it("breaks a stale lock", async () => {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ token: "dead", at: Date.now() - 31_000 }));
    const started = Date.now();
    await withFileLock(path, async () => {
      expect(JSON.parse(readFileSync(path, "utf8")).token).not.toBe("dead");
    });
    expect(Date.now() - started).toBeLessThan(QUICK.waitMs);
    expect(existsSync(path)).toBe(false);
  });

  it("releases the lock when the holder throws", async () => {
    const path = lockPath();
    await expect(
      withFileLock(path, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(path)).toBe(false);
  });
});
