import { createHash, randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage, type ReviewEvent, type ReviewReport } from "@open-cr-agent/core";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import { ocraConfigDir } from "../config/user-dir.js";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { UsageError } from "../io/usage-error.js";
import { Runs } from "../serve/runs.js";
import { type RunRequest, serveServer } from "../serve/server.js";
import type { ReviewArgs } from "./review/args.js";
import { deliver } from "./review/deliver.js";
import type { ReviewDeps } from "./review/deps.js";
import { executeRun } from "./review/execute-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

export const SERVE_USAGE = `Usage: ocra serve [options]

Runs a review service for this repository on 127.0.0.1: POST /runs starts a
review, GET /runs/<id>/events streams its events (Server-Sent Events). The
address and token are written to a file only you can read.

Options:
  --port <n>  Port to listen on (default: a free one)
  -h, --help  Show help
`;

const LIMITS = { concurrent: 2, kept: 20 };
const discard: Output = { write: () => {} };

export async function serveCommand(port: number, err: Output, deps: ReviewDeps): Promise<number> {
  const root = await findRepositoryRoot(deps.cwd);
  const token = randomBytes(32).toString("hex");
  const runs = new Runs(LIMITS, deps.now);
  const io: ReviewIo = { out: discard, err };
  const server = serveServer({
    token,
    runs,
    review: (request) => (signal, onEvent) => reviewOnce(request, signal, onEvent, io, deps),
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  const url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
  const file = stateFile(deps.env, root);
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ url, token, pid: process.pid, root })}\n`, {
    mode: 0o600,
  });
  err.write(`[ocra] Serving reviews of ${root} at ${url}; the token is in ${file}\n`);
  await new Promise<void>((resolve) => {
    const stop = deps.onInterrupt?.(() => {
      stop?.();
      resolve();
    });
  });
  err.write("[ocra] Stopping: cancelling running reviews\n");
  await runs.cancelAll();
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await rm(file, { force: true });
  return EXIT.ok;
}

// One review, as `ocra review --format json` would run it, with its events
// and cancellation wired to the run.
async function reviewOnce(
  request: RunRequest,
  signal: AbortSignal,
  onEvent: (event: ReviewEvent) => void,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<ReviewReport> {
  const args: ReviewArgs = {
    target: request.target,
    format: "json",
    ...(request.reviewers ? { reviewers: request.reviewers } : {}),
    ...(request.maxCostUsd !== undefined ? { maxCostUsd: request.maxCostUsd } : {}),
  };
  const runDeps: ReviewDeps = {
    ...deps,
    onEvent,
    onInterrupt(handler) {
      signal.addEventListener("abort", handler, { once: true });
      return () => signal.removeEventListener("abort", handler);
    },
  };
  const run = await resolveRun(args, io, runDeps);
  const executed = await executeRun(run, args, io, runDeps);
  if (!executed.interrupted) await deliver(run, executed, args, io, runDeps);
  return executed.report;
}

function stateFile(env: ReviewDeps["env"], root: string): string {
  const id = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(ocraConfigDir(env), "serve", `${id}.json`);
}

export function parseServeArgs(argv: string[]): number | "help" {
  let values: { port?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { port: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
  if (values.help) return "help";
  if (values.port === undefined) return 0;
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new UsageError(`--port must be a whole number from 1 to 65535, not "${values.port}"`);
  }
  return port;
}
