import { win32 } from "node:path";

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
