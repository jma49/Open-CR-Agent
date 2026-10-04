import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writePrivateFile } from "./private-file.js";

// The account's repository-hash salt (ADR-0028, 4). The server answers one
// only while the account shares findings, so that a repository hashes alike
// on every machine of the account; null means the per-machine salt stays.
// It is kept beside the credentials, readable only by this user, and
// refreshed at login and by each signed-in review.

const SALT = /^[0-9a-f]{64}$/;

export function accountSaltPath(credentialsPath: string): string {
  return join(dirname(credentialsPath), "account-salt");
}

/** The account's salt in ocra Cloud's answer, or null; throws when it holds none. */
export async function accountSaltOf(res: Response): Promise<string | null> {
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
  await writePrivateFile(path, `${salt}\n`);
}
