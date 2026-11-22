import { join, posix, win32 } from "node:path";

// The npm ci flags that say whether OpenCode is installed, from the Action's
// opencode input.
/** @param {string | undefined} input */
export function opencodeFlags(input) {
  if (input === undefined || input === "" || input === "true") return [];
  if (input === "false") return ["--omit=optional"];
  throw new Error(`the opencode input must be true or false, not ${JSON.stringify(input)}`);
}

/**
 * How to start npm with these arguments, never through a shell. On Windows
 * npm is a .cmd shim that only a shell starts, and the shell would read `&`,
 * `^` and quotes in a path; run the npm that ships with this Node instead,
 * as the CLI's plugin installer does (packages/cli/src/plugins/npm.ts).
 * @param {readonly string[]} args
 * @param {NodeJS.Platform} platform
 * @param {string} execPath
 */
export function npmCommand(args, platform = process.platform, execPath = process.execPath) {
  if (platform !== "win32") return { file: "npm", args: [...args] };
  const cli = win32.join(win32.dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { file: execPath, args: [cli, ...args] };
}

/**
 * The directory of the npm `npmCommand` starts: the one beside this Node.
 * @param {NodeJS.Platform} platform
 * @param {string} execPath
 */
export function npmDir(platform = process.platform, execPath = process.execPath) {
  if (platform === "win32") return win32.join(win32.dirname(execPath), "node_modules", "npm");
  return posix.join(posix.dirname(execPath), "..", "lib", "node_modules", "npm");
}

/**
 * @typedef {{ initTUF(options: { cachePath: string }):
 *   Promise<{ getTarget(name: string): Promise<string> }> }} SigstoreTuf
 */

/**
 * Puts sigstore's trusted root into npm's TUF cache before `npm audit
 * signatures`. npm verifies up to 20 attestations at once; with a cold
 * cache, or one whose seeded root is out of date, each of them downloads
 * trusted_root.json and copies it over the same file while the others read
 * it, so one reads it half written and reports that package's attestation
 * as invalid. Fetched once first, with npm's own TUF client, every check
 * finds it whole and verified.
 * @param {string} npmCache npm's --cache: its TUF cache is `_tuf` in it
 * @param {SigstoreTuf} tuf
 */
export async function cacheTrustedRoot(npmCache, tuf) {
  const client = await tuf.initTUF({ cachePath: join(npmCache, "_tuf") });
  await client.getTarget("trusted_root.json");
}
