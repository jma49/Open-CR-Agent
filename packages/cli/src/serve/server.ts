import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ReviewEvent as WireEvent } from "@open-cr-agent/cloud-contract";
import { errorMessage, toReportOutput } from "@open-cr-agent/core";
import type { LocalTarget } from "@open-cr-agent/vcs-local";
import { z } from "zod";
import { type RunRequest, runRequestSchema } from "../commands/review/request.js";
import { type ReviewStarter, type Run, type Runs, RunsBusy } from "./runs.js";

const MAX_BODY_BYTES = 16_384;
const HEARTBEAT_MS = 15_000;
// A subscriber this far behind is dropped; it can reconnect from its last id.
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface ServeOptions {
  token: string;
  review: (request: RunRequest) => ReviewStarter;
  runs: Runs;
}

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The review service's HTTP routes; see the manual's ocra serve page. */
export function serveServer(options: ServeOptions): Server {
  const expected = Buffer.from(`Bearer ${options.token}`);
  const server = createServer((req, res) => {
    handle(req, res, options, expected, server).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      if (!res.headersSent) json(res, status, { error: errorMessage(error) });
      else res.destroy();
    });
  });
  return server;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  options: ServeOptions,
  expected: Buffer,
  server: Server,
): Promise<void> {
  if (!localHost(req.headers.host, server)) throw new HttpError(421, "unexpected Host");
  if (!authorized(req, expected)) throw new HttpError(401, "missing or wrong token");
  const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
  const [, runsPart, id, action, extra] = pathname.split("/");
  if (runsPart !== "runs" || extra !== undefined) throw new HttpError(404, "no such route");

  if (id === undefined || id === "") {
    if (req.method !== "POST") throw new HttpError(405, "use POST /runs");
    const request = runRequestSchema.safeParse(await jsonBody(req));
    if (!request.success) throw new HttpError(400, z.prettifyError(request.error));
    const run = await startRun(options, request.data);
    return json(res, 201, { runId: run.id });
  }

  const { runs } = options;
  const run = runs.get(id);
  if (!run) throw new HttpError(404, "no such run");
  if (action === undefined) {
    if (req.method === "GET") return json(res, 200, snapshot(run));
    if (req.method === "DELETE") {
      if (!runs.forget(id)) throw new HttpError(409, "the run is still running");
      res.writeHead(204).end();
      return;
    }
  }
  if (action === "events" && req.method === "GET") return stream(req, res, run);
  if (action === "cancel" && req.method === "POST") {
    run.cancel();
    return json(res, 202, snapshot(run));
  }
  if (action === "commands" && req.method === "POST") {
    const command = z.object({ command: z.literal("cancel") }).safeParse(await jsonBody(req));
    if (!command.success) throw new HttpError(400, 'the only command is {"command":"cancel"}');
    run.cancel();
    return json(res, 202, snapshot(run));
  }
  throw new HttpError(405, "method not allowed");
}

async function startRun({ runs, review }: ServeOptions, request: RunRequest): Promise<Run> {
  try {
    return await runs.start(targetLabel(request.target), review(request));
  } catch (error) {
    if (error instanceof RunsBusy) throw new HttpError(429, "too many reviews are running");
    throw new HttpError(422, errorMessage(error));
  }
}

function stream(req: IncomingMessage, res: ServerResponse, run: Run): void {
  const last = Number(req.headers["last-event-id"] ?? 0);
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  const send = (event: WireEvent) => {
    res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event.kind === "finished" || event.kind === "failed") setImmediate(close);
    else if (res.writableLength > MAX_BUFFERED_BYTES) res.destroy();
  };
  const unsubscribe = run.subscribe(Number.isSafeInteger(last) ? last : 0, send);
  req.on("close", close);
}

function snapshot(run: Run) {
  return {
    runId: run.id,
    state: run.state,
    events: run.events.length,
    ...(run.report ? { report: toReportOutput(run.report) } : {}),
  };
}

function targetLabel(target: LocalTarget): string {
  if (target.mode === "range") return `${target.from}..${target.to}`;
  if (target.mode === "commit") return `commit ${target.commit}`;
  return "workspace";
}

function localHost(host: string | undefined, server: Server): boolean {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : -1;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function authorized(req: IncomingMessage, expected: Buffer): boolean {
  const actual = Buffer.from(req.headers.authorization ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function jsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "the body is too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "the body is not JSON");
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
