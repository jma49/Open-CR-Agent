import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

// A child that ignores SIGTERM (a CLI stuck while cleaning up) is killed
// after this grace, so a timed-out run always ends.
export const KILL_GRACE_MS = 30_000;

export function exec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; killGraceMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let timedOut = false;
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        clearTimeout(kill);
        const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
        resolve({ stdout, stderr, exitCode: code, timedOut });
      },
    );
    let kill: NodeJS.Timeout | undefined;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            kill = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
          }, options.timeoutMs);
    child.stdin?.end();
  });
}
