import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { machineSecret, UnreadableSecretError } from "./private-file.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(join(dir, "secret"), 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

function secretFile(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-secret-"));
  dirs.push(dir);
  const path = join(dir, "secret");
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

const SECRET = "a".repeat(64);

describe("machineSecret", () => {
  it("keeps the secret it finds", async () => {
    expect(await machineSecret(secretFile(`${SECRET}\n`))).toBe(SECRET);
  });

  it("replaces a file that holds no secret", async () => {
    const path = secretFile("not a secret\n");
    const made = await machineSecret(path);
    expect(made).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(path, "utf8")).toBe(`${made}\n`);
  });

  // Windows ignores the mode, and root reads the file anyway.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "never replaces a secret it cannot read",
    async () => {
      const path = secretFile(`${SECRET}\n`);
      chmodSync(path, 0o000);
      await expect(machineSecret(path)).rejects.toThrow(UnreadableSecretError);
      chmodSync(path, 0o600);
      expect(readFileSync(path, "utf8")).toBe(`${SECRET}\n`);
    },
  );
});
