import { join } from "node:path";
import { ocraConfigDir } from "../config/user-dir.js";
import { machineSecret } from "../io/private-file.js";

// The key that seals this machine's session logs, so that `ocra review
// --resume` reuses only what ocra wrote here (ADR-0031): a secret of the
// user's, kept with ocra's own state and never in a repository.
export function sessionKeyPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(ocraConfigDir(env), "session-key");
}

export function sessionKey(env: Readonly<Record<string, string | undefined>>): Promise<string> {
  return machineSecret(sessionKeyPath(env));
}
