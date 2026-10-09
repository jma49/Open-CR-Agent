import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readBoundedFile } from "./bounded-file.js";

const dir = mkdtempSync(join(tmpdir(), "ocra-bounded-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const file = join(dir, "file.txt");
writeFileSync(file, "0123456789");
const link = join(dir, "link.txt");
symlinkSync(file, link);

describe("readBoundedFile", () => {
  it("reads a regular file up to the bound", async () => {
    expect(await readBoundedFile(file, { maxBytes: 10, followLinks: false })).toBe("0123456789");
  });

  it("refuses a file past the bound, counting the bytes it read", async () => {
    await expect(readBoundedFile(file, { maxBytes: 9, followLinks: false })).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("larger than 9 bytes"),
    });
  });

  it("refuses a symbolic link unless asked to follow it", async () => {
    await expect(readBoundedFile(link, { maxBytes: 10, followLinks: false })).rejects.toMatchObject(
      { code: "ACCESS_DENIED" },
    );
    expect(await readBoundedFile(link, { maxBytes: 10, followLinks: true })).toBe("0123456789");
  });

  it("refuses what is not a regular file", async () => {
    const sub = join(dir, "sub");
    mkdirSync(sub);
    await expect(readBoundedFile(sub, { maxBytes: 10, followLinks: true })).rejects.toMatchObject({
      code: "INPUT_INVALID",
      message: expect.stringContaining("not a regular file"),
    });
  });

  it("leaves a missing file to the caller", async () => {
    await expect(
      readBoundedFile(join(dir, "missing"), { maxBytes: 10, followLinks: false }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
