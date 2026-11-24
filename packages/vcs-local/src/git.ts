import { execFile, spawn } from "node:child_process";
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
        env: childEnvironment(options.env),
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

const STDERR_CHARS = 4_000;

/**
 * A command's output a line at a time, never held whole. Ends early when
 * `onLine` returns false, or at a line longer than `maxLineBytes`, which is
 * not given.
 */
export function gitLines(
  args: readonly string[],
  options: Pick<GitOptions, "cwd" | "okExitCodes" | "timeoutMs"> & { maxLineBytes: number },
  onLine: (line: string) => boolean,
): Promise<"ended" | "stopped" | "line_too_long"> {
  const okExitCodes = options.okExitCodes ?? [0];
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let cut: "stopped" | "line_too_long" | "timed_out" | undefined;
    const stop = (reason: NonNullable<typeof cut>) => {
      cut = reason;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timed_out"), timeoutMs);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      let start = 0;
      while (!cut) {
        const end = chunk.indexOf(0x0a, start);
        if (end < 0) break;
        const line = Buffer.concat([...pending, chunk.subarray(start, end)]).toString("utf8");
        pending = [];
        pendingBytes = 0;
        start = end + 1;
        if (!onLine(line)) stop("stopped");
      }
      if (cut || start === chunk.length) return;
      pending.push(chunk.subarray(start));
      pendingBytes += chunk.length - start;
      if (pendingBytes > options.maxLineBytes) stop("line_too_long");
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_CHARS);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (cut === "timed_out") {
        reject(new GitError(args, undefined, `timed out after ${Math.round(timeoutMs / 1000)}s`));
      } else if (cut) resolve(cut);
      else if (exitCode !== null && okExitCodes.includes(exitCode)) resolve("ended");
      else reject(new GitError(args, exitCode ?? undefined, stderr));
    });
  });
}

export function childEnvironment(
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...gitEnvironment(process.env), LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0", ...extra };
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

// Only a fetch and the push of a merge (ADR-0079) reach a remote, so only
// they get what credential helpers read from the environment: gh's and glab's tokens and Git
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

// Attributes decide which files diff as binary, and binary files are not
// reviewed, so the reviewed commits must not set them: they come from the
// base commit, which the reviewer trusts, rather than from the work tree
// (where a pull request review has the head checked out). git before 2.41
// has no --attr-source; there the work tree's apply, and the review warns
// about text files it excluded as binary.
const ATTR_SOURCE_SINCE = [2, 41] as const;
const BATCH_COMMAND_SINCE = [2, 36] as const;
let version: Promise<string> | undefined;

function gitVersion(root: string): Promise<string> {
  version ??= git(["version"], { cwd: root }).catch(() => "");
  return version;
}

export async function attributesFrom(root: string, commit: string): Promise<string[]> {
  return supportsAttrSource(await gitVersion(root)) ? [`--attr-source=${commit}`] : [];
}

export function supportsAttrSource(version: string): boolean {
  return versionAtLeast(version, ATTR_SOURCE_SINCE);
}

/** Whether git has `cat-file --batch-command`. */
export async function hasBatchCommand(root: string): Promise<boolean> {
  return versionAtLeast(await gitVersion(root), BATCH_COMMAND_SINCE);
}

function versionAtLeast(version: string, [sinceMajor, sinceMinor]: readonly [number, number]) {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > sinceMajor || (major === sinceMajor && minor >= sinceMinor);
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
