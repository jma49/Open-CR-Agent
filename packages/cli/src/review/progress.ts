import type { ReviewEvent } from "@open-cr-agent/core";

export interface Output {
  write(chunk: string): unknown;
}

export interface ProgressOptions {
  heartbeatMs: number;
  now: () => number;
}

export class ProgressPrinter {
  private lastOutput: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly err: Output,
    private readonly options: ProgressOptions,
  ) {
    this.lastOutput = options.now();
    this.timer = setInterval(() => this.heartbeat(), options.heartbeatMs);
    this.timer.unref?.();
  }

  onEvent(event: ReviewEvent): void {
    const line = describe(event);
    if (line !== undefined) this.print(line);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private heartbeat(): void {
    const silentMs = this.options.now() - this.lastOutput;
    if (silentMs >= this.options.heartbeatMs) {
      this.print(`Model is thinking... (${Math.round(silentMs / 1000)}s since last update)`);
    }
  }

  private print(line: string): void {
    this.lastOutput = this.options.now();
    this.err.write(`[ocra] ${line}\n`);
  }
}

function describe(event: ReviewEvent): string | undefined {
  switch (event.type) {
    case "run_started":
      return `Reviewing: ${event.changeRequest.title}`;
    case "files_selected":
      return `${event.selected} file(s) selected, ${event.excluded} excluded · risk tier: ${event.tier}`;
    case "files_bundled":
      return [`${event.bundles} review task(s) (${event.strategy})`, ...event.warnings].join(
        "\n[ocra] ",
      );
    case "task_started":
      return `${event.taskId} started: ${event.bundle} (${event.files.length} file(s))`;
    case "task_finished": {
      const { outcome } = event;
      const seconds = (outcome.durationMs / 1000).toFixed(1);
      return outcome.status === "completed"
        ? `${outcome.taskId} completed in ${seconds}s · ${outcome.findings} finding(s)`
        : `${outcome.taskId} ${outcome.status.replace("_", " ")} after ${seconds}s: ${outcome.error ?? "unknown error"}`;
    }
    default:
      return undefined;
  }
}
