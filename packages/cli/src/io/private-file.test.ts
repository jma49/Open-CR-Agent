import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineSecretError, machineSecret, writePrivateFile } from "./private-file.js";

// What the writes do, in order: the passthroughs record each sync and rename.
const done: string[] = [];
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: vi.fn(async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        done.push(`sync ${args[0]}`);
        await sync();
      };
      return handle;
    }),
    rename: vi.fn(async (from: string, to: string) => {
      done.push(`rename ${to}`);
      await fs.rename(from, to);
    }),
  };
});

const dirs: string[] = [];
afterEach(() => {
  done.length = 0;
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
      await expect(machineSecret(path)).rejects.toThrow(MachineSecretError);
      chmodSync(path, 0o600);
      expect(readFileSync(path, "utf8")).toBe(`${SECRET}\n`);
    },
  );
});

describe("writePrivateFile", () => {
  it("has the text on disk before the file replaces the old one", async () => {
    const path = secretFile("old\n");
    await writePrivateFile(path, "new\n");
    expect(readFileSync(path, "utf8")).toBe("new\n");
    const synced = done.findIndex((d) => /^sync .*\.tmp$/.test(d));
    expect(synced).toBeGreaterThanOrEqual(0);
    expect(synced).toBeLessThan(done.indexOf(`rename ${path}`));
  });

  it("tries the rename again while Windows holds the file a moment", async () => {
    const path = secretFile("old\n");
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    const busy = (code: string) => Object.assign(new Error(code), { code });
    vi.mocked(rename).mockRejectedValueOnce(busy("EPERM")).mockRejectedValueOnce(busy("EBUSY"));
    try {
      await writePrivateFile(path, "new\n");
    } finally {
      if (platform) Object.defineProperty(process, "platform", platform);
    }
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });
});
