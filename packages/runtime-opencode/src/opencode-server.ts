import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

export interface OpencodeServer {
  url: string;
  authorization: string;
  close(): Promise<void>;
  // For a process that is exiting now and cannot wait for close().
  killNow(): void;
}

export interface StartOptions {
  binary: string;
  // OpenCode treats the directory it runs in as a project: a request that
  // names no directory loads that project's plugins, tools and config. It
  // must be a directory ocra owns, never the reviewed checkout.
  cwd: string;
  env: Record<string, string>;
  config: unknown;
  startupTimeoutMs?: number;
}

const LISTENING = /opencode server listening on (https?:\/\/\S+)/;

export async function startOpencodeServer(options: StartOptions): Promise<OpencodeServer> {
  const port = await freePort();
  const password = randomBytes(24).toString("hex");
  const child = spawn(options.binary, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    cwd: options.cwd,
    env: {
      ...options.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const url = await waitForListening(child, options.startupTimeoutMs ?? 30_000);
  return {
    url,
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    close: () => stop(child),
    killNow: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

const STARTUP_OUTPUT_CHARS = 16_000;

function waitForListening(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const fail = (message: string) => {
      clearTimeout(timer);
      void stop(child);
      reject(new Error(`${message}${output.trim() ? `\n${output.trim()}` : ""}`));
    };
    const timer = setTimeout(() => fail(`OpenCode did not start within ${timeoutMs}ms`), timeoutMs);
    // Only the tail matters for a startup error message.
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-STARTUP_OUTPUT_CHARS);
    };
    const onData = (chunk: Buffer) => {
      keep(chunk);
      const match = LISTENING.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        // Past startup the output is not needed, but it must still be read:
        // a full pipe would block OpenCode's next write.
        child.stdout?.off("data", onData);
        child.stderr?.off("data", keep);
        child.stdout?.resume();
        child.stderr?.resume();
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", keep);
    child.once("error", (error) => fail(`OpenCode failed to start: ${error.message}`));
    child.once("exit", (code) => fail(`OpenCode exited with code ${code} during startup`));
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
