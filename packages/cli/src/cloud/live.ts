import { type LiveRun, MAX_LIVE_BATCH, MAX_LIVE_BATCH_BYTES } from "@open-cr-agent/cloud-contract";
import type { ReviewEvent } from "@open-cr-agent/core";
import { ReviewEventMapper } from "../serve/review-events.js";
import { CloudClient, sessionLostReason } from "./client.js";
import type { CloudDeps } from "./deps.js";

// Relays a running review's events to ocra Cloud (ADR-0056), so the people
// the account shares the run with can watch it. Best effort: one batch in
// flight, a failed batch retried at the next tick, and after a few failures
// in a row the relay stops with one warning. The review never waits on it,
// except for close() at its end, which is bounded.

export interface LiveRelayOptions {
  flushMs?: number;
  closeMs?: number;
  /** Prints where the run can be watched, once. */
  notice: (message: string) => void;
  warn: (message: string) => void;
}

const FLUSH_MS = 1_000;
const CLOSE_MS = 5_000;
const MAX_FAILURES = 3;
// A batch's text is kept under the server's limit with room for the run's fields.
const BATCH_BYTES = MAX_LIVE_BATCH_BYTES - 4_096;

type WireEvent = ReturnType<ReviewEventMapper["map"]>[number];

export class LiveRelay {
  private mapper: ReviewEventMapper | undefined;
  private queue: WireEvent[] = [];
  private sending: Promise<void> | undefined;
  private failures = 0;
  private stopped = false;
  private watching = false;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly client: CloudClient;
  private readonly run: LiveRun;
  private readonly target: string;
  private readonly options: LiveRelayOptions;

  constructor(deps: CloudDeps, run: LiveRun, target: string, options: LiveRelayOptions) {
    this.client = new CloudClient(deps);
    this.run = run;
    this.target = target;
    this.options = options;
    this.timer = setInterval(() => this.flush(), options.flushMs ?? FLUSH_MS);
    this.timer.unref();
  }

  onEvent(event: ReviewEvent, cancelled: boolean): void {
    if (this.stopped) return;
    if (event.type === "run_started")
      this.mapper ??= new ReviewEventMapper(event.runId, this.target);
    if (!this.mapper) return;
    // A cancelled run still reports what it found, but did not finish.
    if (event.type === "run_finished" && cancelled)
      this.queue.push(this.mapper.failed("cancelled"));
    else this.queue.push(...this.mapper.map(event));
  }

  /** The run ended without a report. */
  failed(reason: "budget" | "error", message: string): void {
    if (!this.stopped && this.mapper) this.queue.push(this.mapper.failed(reason, message));
  }

  /** Sends what is left, for at most closeMs, and stops. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    const deadline = Date.now() + (this.options.closeMs ?? CLOSE_MS);
    while (!this.stopped && (this.queue.length > 0 || this.sending) && Date.now() < deadline) {
      this.flush();
      const left = deadline - Date.now();
      await Promise.race([this.sending, new Promise((r) => setTimeout(r, Math.max(left, 0)))]);
    }
    this.stopped = true;
  }

  private flush(): void {
    if (this.stopped || this.sending || this.queue.length === 0) return;
    const batch = takeBatch(this.queue);
    this.sending = this.send(batch).finally(() => {
      this.sending = undefined;
    });
  }

  private async send(events: WireEvent[]): Promise<void> {
    let problem: string | undefined;
    try {
      const answer = await this.client.liveEvents({ run: this.run, events });
      if (answer.kind === "ok") {
        this.failures = 0;
        this.queue.splice(0, events.length);
        if (answer.value.watch === undefined) return this.stop();
        if (!this.watching)
          this.options.notice(`[ocra] Watch this review live: ${answer.value.watch}`);
        this.watching = true;
        return;
      }
      // Signed out, or a server that relays nothing yet.
      if (answer.kind === "signed-out" || (answer.kind === "status" && answer.status === 404)) {
        return this.stop();
      }
      problem =
        answer.kind === "status"
          ? `HTTP ${answer.status}`
          : answer.kind === "malformed"
            ? "an answer it could not read"
            : sessionLostReason(answer);
    } catch (error) {
      problem = error instanceof Error ? error.name : "error";
    }
    this.failures += 1;
    if (this.failures >= MAX_FAILURES) {
      this.options.warn(`stopped relaying this review to ocra Cloud live (${problem})`);
      this.stop();
    }
  }

  private stop(): void {
    this.stopped = true;
    this.queue = [];
    clearInterval(this.timer);
  }
}

// The oldest events, as many as fit in one batch; the queue keeps them
// until the server took them.
function takeBatch(queue: readonly WireEvent[]): WireEvent[] {
  const batch: WireEvent[] = [];
  let bytes = 0;
  for (const event of queue) {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (batch.length === MAX_LIVE_BATCH || (batch.length > 0 && bytes + size > BATCH_BYTES)) break;
    batch.push(event);
    bytes += size;
  }
  return batch;
}
