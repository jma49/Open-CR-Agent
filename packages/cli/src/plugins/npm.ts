import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { forTerminal } from "../io/terminal.js";
import { ConfigError } from "../review/config.js";

/**
 * Runs npm with these arguments in `cwd`, never through a shell; resolves
 * with its standard output. Every call runs in the plugin directory, so the
 * npm configuration of whatever project ocra was started in does not apply.
 */
export type NpmRunner = (args: readonly string[], cwd: string) => Promise<string>;

// npm on Windows is npm.cmd, which execFile cannot run without a shell; run
// the npm that ships with this Node directly instead.
export function defaultNpm(env: NodeJS.ProcessEnv = process.env): NpmRunner {
  const [file, prefix] =
    process.platform === "win32"
      ? [
          process.execPath,
          [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")],
        ]
      : ["npm", []];
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        [...prefix, ...args],
        { cwd, env, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024, shell: false },
        (error, stdout, stderr) => {
          if (error) {
            reject(
              new ConfigError(
                `npm ${args[0]} failed: ${forTerminal(String(stderr).trim().split("\n").slice(-3).join(" ") || error.message)}`,
              ),
            );
          } else resolve(String(stdout));
        },
      );
    });
}
