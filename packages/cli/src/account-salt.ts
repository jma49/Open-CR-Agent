import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CloudDeps } from "./cloud.js";
import { VERSION } from "./version.js";

// The account's repository-hash salt (ADR-0028, 4). The server answers one
// only while the account shares findings, so that a repository hashes alike
// on every machine of the account; null means the per-machine salt stays.
// It is kept beside the credentials, readable only by this user, and
// refreshed at login and by each signed-in review.

const SALT = /^[0-9a-f]{64}$/;

export function accountSaltPath(credentialsPath: string): string {
  return join(dirname(credentialsPath), "account-salt");
}

/** The account's salt, or null; throws when the server cannot be asked. */
export async function fetchAccountSalt(
  deps: Pick<CloudDeps, "fetch">,
  server: string,
  token: string,
): Promise<string | null> {
  const res = await deps.fetch(`${server}/api/account/salt`, {
    headers: { authorization: `Bearer ${token}`, "user-agent": `ocra/${VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  // A server without account salts shares no findings.
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { salt?: unknown };
  if (body.salt === null) return null;
  if (typeof body.salt === "string" && SALT.test(body.salt)) return body.salt;
  throw new Error("the answer is not a salt");
}

/** Keeps the salt beside the credentials (0600), or removes it when the account has none. */
export async function saveAccountSalt(credentialsPath: string, salt: string | null): Promise<void> {
  const path = accountSaltPath(credentialsPath);
  if (salt === null) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${salt}\n`, { mode: 0o600 });
  // writeFile keeps the mode of a file that already exists.
  await chmod(path, 0o600);
}
