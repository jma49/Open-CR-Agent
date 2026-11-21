import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { childEnvironment } from "./git.js";

// How long a read may take before the reader gives up on its process.
const READ_TIMEOUT_MS = 60_000;
// An idle process is ended so a finished review leaves none behind.
const IDLE_MS = 250;

type Pending =
  | { kind: "info"; resolve: (info: BlobInfo | undefined) => void; reject: (e: Error) => void }
  | { kind: "contents"; resolve: (bytes: Buffer) => void; reject: (e: Error) => void };

interface BlobInfo {
  oid: string;
  type: string;
  size: number;
}

/**
 * Reads blobs of a revision through one `git cat-file --batch-command`
 * instead of a process per file: an agent and anchoring read hundreds of
 * files a run. Undefined for a path that is not a blob there, like
 * `git cat-file blob` failing; a blob over `maxBytes` is left to the caller,
 * which reads its start alone.
 */
export class BlobReader {
  private readonly root: string;
  private child: ChildProcessWithoutNullStreams | undefined;
  private pending: Pending[] = [];
  private buffer = Buffer.alloc(0);
  private idle: NodeJS.Timeout | undefined;
  private timeout: NodeJS.Timeout | undefined;

  constructor(root: string) {
    this.root = root;
  }

  async read(
    name: string,
    maxBytes: number,
  ): Promise<{ text: string } | { tooLarge: true } | undefined> {
    const info = await this.send<BlobInfo | undefined>("info", `info ${name}`);
    if (info?.type !== "blob") return undefined;
    if (info.size > maxBytes) return { tooLarge: true };
    const bytes = await this.send<Buffer>("contents", `contents ${info.oid}`);
    return { text: bytes.toString("utf8") };
  }

  private send<T>(kind: Pending["kind"], command: string): Promise<T> {
    const child = this.process();
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ kind, resolve, reject } as Pending);
      this.arm();
      child.stdin.write(`${command}\n`);
    });
  }

  private process(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn("git", ["cat-file", "--batch-command"], {
      cwd: this.root,
      env: childEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    child.stderr.resume();
    child.on("error", (error) => this.fail(child, error));
    child.on("close", (code) => this.fail(child, new Error(`git cat-file exited with ${code}`)));
    child.stdin.on("error", (error) => this.fail(child, error));
    this.child = child;
    return child;
  }

  private drain(): void {
    for (;;) {
      const next = this.pending[0];
      if (!next) break;
      const end = this.buffer.indexOf(0x0a);
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString("utf8");
      if (next.kind === "info") {
        this.buffer = this.buffer.subarray(end + 1);
        this.pending.shift();
        next.resolve(parseInfo(header));
        continue;
      }
      const info = parseInfo(header);
      if (!info) {
        this.buffer = this.buffer.subarray(end + 1);
        this.pending.shift();
        next.reject(new Error(`git cat-file: ${header}`));
        continue;
      }
      // The contents, then a line feed.
      if (this.buffer.length < end + 1 + info.size + 1) return;
      const bytes = Buffer.from(this.buffer.subarray(end + 1, end + 1 + info.size));
      this.buffer = this.buffer.subarray(end + 1 + info.size + 1);
      this.pending.shift();
      next.resolve(bytes);
    }
    this.arm();
  }

  // While a read is waiting, a timeout; once none is, the idle timer.
  private arm(): void {
    clearTimeout(this.idle);
    clearTimeout(this.timeout);
    const child = this.child;
    if (!child) return;
    hold(child, this.pending.length > 0);
    if (this.pending.length > 0) {
      this.timeout = setTimeout(
        () => this.fail(child, new Error("git cat-file timed out")),
        READ_TIMEOUT_MS,
      ).unref();
    } else {
      this.idle = setTimeout(() => this.stop(child), IDLE_MS).unref();
    }
  }

  private stop(child: ChildProcessWithoutNullStreams): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    child.stdin.end();
  }

  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.buffer = Buffer.alloc(0);
    clearTimeout(this.idle);
    clearTimeout(this.timeout);
    const pending = this.pending;
    this.pending = [];
    child.kill("SIGKILL");
    for (const p of pending) p.reject(error);
  }
}

// A review that ends while the reader is idle must not wait for it, and one
// waiting on a read must not end.
function hold(child: ChildProcessWithoutNullStreams, held: boolean): void {
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
    const h = handle as unknown as { ref?: () => void; unref?: () => void };
    if (held) h.ref?.();
    else h.unref?.();
  }
}

// "<oid> <type> <size>", or "<name> missing" (or ambiguous) for none.
function parseInfo(header: string): BlobInfo | undefined {
  const match = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(header);
  if (!match) return undefined;
  return { oid: match[1] as string, type: match[2] as string, size: Number(match[3]) };
}
