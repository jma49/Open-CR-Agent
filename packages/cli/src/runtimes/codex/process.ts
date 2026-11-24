import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Codex gets this long to stop after SIGTERM before SIGKILL.
const KILL_GRACE_MS = 2_000;
// The end of stderr is where Codex says why it failed.
const STDERR_TAIL = 4_000;

export interface RunInput {
  binary: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  onLine(line: string): void;
  // Every live Codex process, so the runtime can stop them on exit.
  live: Set<ChildProcess>;
}

export interface RunResult {
  code: number | null;
  stderr: string;
}

// Runs Codex in a process group of its own, so stopping it stops what it
// started too.
export function runCodex(input: RunInput): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.binary, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    input.live.add(child);
    let stderr = "";
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      terminate(child, "SIGTERM");
      killTimer = setTimeout(() => terminate(child, "SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    if (input.signal.aborted) stop();
    else input.signal.addEventListener("abort", stop, { once: true });

    createInterface({ input: child.stdout }).on("line", input.onLine);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin);

    child.once("error", (error) => {
      input.signal.removeEventListener("abort", stop);
      input.live.delete(child);
      reject(error);
    });
    child.once("close", (code) => {
      input.signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
      input.live.delete(child);
      resolve({ code, stderr });
    });
  });
}

export function terminate(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}
