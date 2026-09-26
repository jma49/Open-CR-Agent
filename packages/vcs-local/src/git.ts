import { execFile } from "node:child_process";

export interface GitOptions {
  cwd: string;
  input?: string;
  okExitCodes?: readonly number[];
  env?: Readonly<Record<string, string>>;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (exit ${exitCode ?? "unknown"}): ${stderr.trim()}`);
  }
}

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

export function git(args: readonly string[], options: GitOptions): Promise<string> {
  const okExitCodes = options.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", ...options.env },
      },
      (error, stdout, stderr) => {
        const exitCode = error ? (typeof error.code === "number" ? error.code : undefined) : 0;
        if (exitCode !== undefined && okExitCodes.includes(exitCode)) resolve(stdout);
        else reject(new GitError(args, exitCode, stderr || String(error?.message ?? "")));
      },
    );
    // git may exit before reading stdin; its exit code already reports the
    // outcome, so a broken pipe on our side carries no information.
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") reject(error);
    });
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}
