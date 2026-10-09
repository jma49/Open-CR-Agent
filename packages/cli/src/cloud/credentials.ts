import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ocraConfigDir } from "../config/user-dir.js";
import { writePrivateFile } from "../io/private-file.js";

export type Credentials = {
  server: string;
  login: string;
  access_token: string;
  refresh_token: string;
  /** Epoch milliseconds when the access token expires. */
  expires_at: number;
  /** How long an access token lives from its issue, as the server last said. */
  lifetime_ms?: number;
};

export function credentialsHint(): string {
  return process.platform === "win32"
    ? "%APPDATA%\\ocra\\credentials.json"
    : "~/.config/ocra/credentials.json";
}

export function credentialsPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(ocraConfigDir(env), "credentials.json");
}

/**
 * The saved session; undefined when there is none or the file does not hold
 * one, which `warn` hears about (a file cut short by a crash, or edited).
 */
export async function readCredentials(
  path: string,
  warn?: (message: string) => void,
): Promise<Credentials | undefined> {
  const saved = await loadCredentials(path);
  if (saved !== "unreadable") return saved;
  warn?.(`ignoring ${path}: it holds no ocra Cloud session; run ocra login to sign in again`);
  return undefined;
}

export async function loadCredentials(
  path: string,
): Promise<Credentials | "unreadable" | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let c: Partial<Credentials> | null;
  try {
    c = JSON.parse(text) as Partial<Credentials> | null;
  } catch {
    return "unreadable";
  }
  if (
    typeof c !== "object" ||
    c === null ||
    !c.server ||
    !c.access_token ||
    !c.refresh_token ||
    typeof c.expires_at !== "number"
  ) {
    return "unreadable";
  }
  // Only an estimate of what a renewal gives; without it, renewal is tried.
  const { lifetime_ms, ...session } = c as Credentials;
  return typeof lifetime_ms === "number" && lifetime_ms > 0 ? { ...session, lifetime_ms } : session;
}

export async function writeCredentials(path: string, c: Credentials): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(c, null, 2)}\n`);
}
