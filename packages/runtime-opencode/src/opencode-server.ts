import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

export interface OpencodeServer {
  url: string;
  authorization: string;
  close(): Promise<void>;
}

export interface StartOptions {
  binary: string;
  env: Record<string, string>;
  config: unknown;
  startupTimeoutMs?: number;
}

const LISTENING = /opencode server listening on (https?:\/\/\S+)/;

export async function startOpencodeServer(options: StartOptions): Promise<OpencodeServer> {
  const port = await freePort();
  const password = randomBytes(24).toString("hex");
  const child = spawn(options.binary, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
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
  };
}

function waitForListening(child: ChildProcess, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const fail = (message: string) => {
      clearTimeout(timer);
      void stop(child);
      reject(new Error(`${message}${output.trim() ? `\n${output.trim()}` : ""}`));
    };
    const timer = setTimeout(() => fail(`OpenCode did not start within ${timeoutMs}ms`), timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const match = LISTENING.exec(output);
      if (match?.[1]) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(match[1]);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
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
