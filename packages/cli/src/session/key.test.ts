import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sessionKey, sessionKeyPath } from "./key.js";

const home = mkdtempSync(join(tmpdir(), "ocra-key-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const env = { XDG_CONFIG_HOME: home, APPDATA: home };

describe("sessionKey", () => {
  it("is made once in the user's ocra directory, readable only by the user", async () => {
    const key = await sessionKey(env);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await sessionKey(env)).toBe(key);
    const path = sessionKeyPath(env);
    expect(path).toBe(join(home, "ocra", "session-key"));
    expect(readFileSync(path, "utf8").trim()).toBe(key);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
