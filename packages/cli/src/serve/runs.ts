import type { ReviewEvent as WireEvent } from "@open-cr-agent/cloud-contract";
import {
  errorMessage,
  isOcraError,
  type ReviewEvent,
  type ReviewReport,
} from "@open-cr-agent/core";
import { ReviewEventMapper } from "./review-events.js";

export type ReviewStarter = (
  signal: AbortSignal,
  onEvent: (event: ReviewEvent) => void,
) => Promise<ReviewReport>;

export type RunState = "running" | "finished" | "failed";

type Listener = (event: WireEvent) => void;

// Past this many events a run stops sending usage events; its finished
// event still carries the total.
const MAX_EVENTS = 20_000;

export class Run {
  readonly id: string;
  readonly events: WireEvent[] = [];
  state: RunState = "running";
  report?: ReviewReport;
  endedAt?: number;
  readonly ended: Promise<void>;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<Listener>();
  private markEnded = () => {};

  constructor(id: string) {
    this.id = id;
    this.ended = new Promise((resolve) => {
      this.markEnded = resolve;
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  cancel(): void {
    this.controller.abort();
  }

  /** Replays the events after `seq`, then sends each new one until it is unsubscribed. */
  subscribe(seq: number, listener: Listener): () => void {
    for (const event of this.events) if (event.seq > seq) listener(event);
    if (this.state === "running") this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  push(event: WireEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  full(): boolean {
    return this.events.length >= MAX_EVENTS;
  }

  end(state: Exclude<RunState, "running">, at: number): void {
    this.state = state;
    this.endedAt = at;
    this.listeners.clear();
    this.markEnded();
  }
}

export class RunsBusy extends Error {}

export interface RunLimits {
  concurrent: number;
  kept: number;
}

/** The runs of one server: started, followed, cancelled and forgotten by id. */
export class Runs {
  private readonly runs = new Map<string, Run>();
  // Reviews started and not settled, those still resolving their run included.
  private active = 0;
  private readonly limits: RunLimits;
  private readonly now: () => number;

  constructor(limits: RunLimits, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  forget(id: string): boolean {
    const run = this.runs.get(id);
    if (!run || run.state === "running") return false;
    return this.runs.delete(id);
  }

  async cancelAll(): Promise<void> {
    const running = [...this.runs.values()].filter((run) => run.state === "running");
    for (const run of running) run.cancel();
    await Promise.all(running.map((run) => run.ended));
  }

  /**
   * Starts a review and resolves with its run once the engine names it, so
   * a request that cannot start (no repository, a bad configuration) is
   * refused instead of becoming a run.
   */
  start(target: string, review: ReviewStarter): Promise<Run> {
    if (this.active >= this.limits.concurrent) return Promise.reject(new RunsBusy());
    this.active += 1;
    const controller = new AbortController();
    let run: Run | undefined;
    let mapper: ReviewEventMapper | undefined;
    return new Promise<Run>((resolve, reject) => {
      const onEvent = (event: ReviewEvent) => {
        if (event.type === "run_started" && !run) {
          run = new Run(event.runId);
          run.signal.addEventListener("abort", () => controller.abort(), { once: true });
          mapper = new ReviewEventMapper(event.runId, target, this.now);
          this.runs.set(run.id, run);
          resolve(run);
        }
        if (!run || !mapper || (event.type === "usage_reported" && run.full())) return;
        // A cancelled run still reports what it found, but did not finish.
        if (event.type === "run_finished" && controller.signal.aborted) {
          run.report = event.report;
          run.push(mapper.failed("cancelled"));
          return;
        }
        for (const wire of mapper.map(event)) run.push(wire);
      };
      review(controller.signal, onEvent)
        .finally(() => {
          this.active -= 1;
        })
        .then(
          (report) => {
            if (!run) return reject(new Error("the review ended before it started"));
            run.report = report;
            this.end(run, controller.signal.aborted ? "failed" : "finished");
          },
          (error: unknown) => {
            if (!run || !mapper) return reject(error);
            const reason = controller.signal.aborted
              ? "cancelled"
              : isOcraError(error) && error.code === "BUDGET_EXHAUSTED"
                ? "budget"
                : "error";
            run.push(mapper.failed(reason, errorMessage(error)));
            this.end(run, "failed");
          },
        );
    });
  }

  private end(run: Run, state: Exclude<RunState, "running">): void {
    run.end(state, this.now());
    const ended = [...this.runs.values()]
      .filter((r) => r.state !== "running")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const old of ended.slice(0, Math.max(0, ended.length - this.limits.kept))) {
      this.runs.delete(old.id);
    }
  }
}
