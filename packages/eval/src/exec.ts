import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function exec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        timeout: options.timeoutMs,
        maxBuffer: 256 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? -1 : 0;
        resolve({ stdout, stderr, exitCode: code });
      },
    );
    child.stdin?.end();
  });
}
