import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLock } from "./file-lock.js";

// What Windows does, on any system: a create refused with EPERM, as for a
// file whose removal is pending or a directory that takes no new file.
const refused = vi.hoisted(() => ({ create: (_path: string): boolean => false }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const writeFile: typeof real.writeFile = async (file, ...rest) => {
    if (refused.create(String(file))) {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    return real.writeFile(file, ...rest);
  };
  return { ...real, writeFile };
});

const QUICK = { waitMs: 2_000, staleMs: 30_000, noticeMs: 10_000, pollMs: 10 };
const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;

beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  refused.create = () => false;
});

describe("withFileLock on Windows", () => {
  it("takes the lock once a removal refused its create has ended, never going without it", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ocra-lock-")), "x.lock");
    // Refused while the last holder's lock was being removed; gone by the time it looks.
    let refusals = 1;
    refused.create = (file) => file === path && refusals-- > 0;
    const heldInside = await withFileLock(path, async () => existsSync(path), QUICK);
    expect(heldInside).toBe(true);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it("removes a probe a killed process left beside the lock, once it is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-lock-"));
    const path = join(dir, "x.lock");
    const left = `${path}.${"a".repeat(16)}.probe`;
    const inUse = `${path}.${"b".repeat(16)}.probe`;
    writeFileSync(left, "");
    writeFileSync(inUse, "");
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(left, tenMinutesAgo, tenMinutesAgo);
    let refusals = 1;
    refused.create = (file) => file === path && refusals-- > 0;
    await withFileLock(path, async () => {}, QUICK);
    expect(readdirSync(dir)).toEqual(["x.lock.bbbbbbbbbbbbbbbb.probe"]);
  });

  it("goes on at once without a lock where no file can be made", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-lock-"));
    const path = join(dir, "x.lock");
    refused.create = (file) => file.startsWith(dir);
    const started = Date.now();
    expect(await withFileLock(path, async () => "ran", QUICK)).toBe("ran");
    expect(Date.now() - started).toBeLessThan(QUICK.waitMs);
    expect(readdirSync(dir)).toEqual([]);
  });
});
