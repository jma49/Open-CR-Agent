import { execFile } from "node:child_process";
import { OcraError } from "@open-cr-agent/core";
import { errnoCode } from "@open-cr-agent/core/internal";

export interface GitOptions {
  cwd: string;
  input?: string;
  okExitCodes?: readonly number[];
  env?: Readonly<Record<string, string>>;
  // Keep at most this much output and treat a longer one as complete, for
  // commands whose output is only sampled (search results).
  truncateAt?: number;
  timeoutMs?: number;
}

// Every git call ends: a fetch can wait on the network forever, and a diff
// of a huge repository should fail rather than hang the review.
const GIT_TIMEOUT_MS = 10 * 60_000;

export class GitError extends OcraError {
  readonly args: readonly string[];
  readonly exitCode: number | undefined;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | undefined, stderr: string) {
    super(
      "VCS_GIT_FAILED",
      `git ${args.join(" ")} failed (exit ${exitCode ?? "unknown"}): ${stderr.trim()}`,
    );
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.name = "GitError";
  }
}

const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const CLOSED_PIPE = new Set(["EPIPE", "ENOTCONN", "ECONNRESET", "EOF"]);

export function git(args: readonly string[], options: GitOptions): Promise<string> {
  const okExitCodes = options.okExitCodes ?? [0];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: options.truncateAt ?? MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        env: {
          ...gitEnvironment(process.env),
          LC_ALL: "C",
          GIT_OPTIONAL_LOCKS: "0",
          ...options.env,
        },
      },
      (error, stdout, stderr) => {
        if (
          options.truncateAt !== undefined &&
          (error as { code?: unknown } | null)?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
        ) {
          resolve(stdout);
          return;
        }
        if (error?.killed && error.signal === "SIGKILL") {
          const seconds = Math.round((options.timeoutMs ?? GIT_TIMEOUT_MS) / 1000);
          reject(new GitError(args, undefined, `timed out after ${seconds}s`));
          return;
        }
        const exitCode = error ? (typeof error.code === "number" ? error.code : undefined) : 0;
        if (exitCode !== undefined && okExitCodes.includes(exitCode)) resolve(stdout);
        else reject(new GitError(args, exitCode, stderr || String(error?.message ?? "")));
      },
    );
    // git may exit before reading stdin; its exit code already reports the
    // outcome, so a broken pipe on our side carries no information. Which
    // error that is depends on timing and platform (EPIPE, ENOTCONN on
    // macOS when the pipe closed before the write, EOF on Windows).
    child.stdin?.on("error", (error) => {
      if (!CLOSED_PIPE.has(errnoCode(error) ?? "")) reject(error);
    });
    if (options.input === undefined) child.stdin?.end();
    else child.stdin?.end(options.input);
  });
}

// git and what it starts (ssh, credential helpers, proxies) see only what
// they need of ocra's environment, never its model keys or platform tokens.
// git's own variables pass whole: they are its configuration (GIT_DIR in a
// hook, GIT_SSH_COMMAND, GIT_CONFIG_*), named by whoever started ocra.
const PASSED_PREFIXES = ["GIT_", "SSH_"];
const PASSED = new Set([
  "PATH",
  "HOME",
  "XDG_CONFIG_HOME",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  // Windows, where names are case-insensitive (process.env keeps "Path").
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
]);

export function gitEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return pick(
    env,
    (upper) => PASSED.has(upper) || PASSED_PREFIXES.some((p) => upper.startsWith(p)),
  );
}

// Only a fetch reaches a remote, so only a fetch gets what credential
// helpers read from the environment: gh's and glab's tokens and Git
// Credential Manager's settings.
const CREDENTIAL_PREFIXES = ["GH_", "GLAB_", "GITLAB_", "GCM_"];
const CREDENTIAL_NAMES = new Set(["GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

export function credentialEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return pick(
    env,
    (upper) => CREDENTIAL_NAMES.has(upper) || CREDENTIAL_PREFIXES.some((p) => upper.startsWith(p)),
  );
}

function pick(
  env: Readonly<Record<string, string | undefined>>,
  passes: (upperCaseName: string) => boolean,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && passes(name.toUpperCase())) picked[name] = value;
  }
  return picked;
}

// CI checkouts are shallow by default; commits beyond the cut-off look
// unrelated to git, which surfaces as a failed merge-base.
export async function isShallow(root: string): Promise<boolean> {
  const out = await git(["rev-parse", "--is-shallow-repository"], {
    cwd: root,
    okExitCodes: [0, 128],
  });
  return out.trim() === "true";
}

export const SHALLOW_HINT =
  "the clone is shallow; fetch the full history (for example actions/checkout with fetch-depth: 0)";
