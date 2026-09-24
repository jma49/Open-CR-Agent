import { describe, expect, it, vi } from "vitest";
import { ProgressPrinter } from "./progress.js";

describe("ProgressPrinter", () => {
  it("prints events and a heartbeat only after a silent interval", () => {
    vi.useFakeTimers();
    let now = 0;
    const lines: string[] = [];
    const printer = new ProgressPrinter(
      { write: (l: string) => lines.push(l) },
      { heartbeatMs: 1000, now: () => now },
    );

    printer.onEvent({
      type: "task_started",
      taskId: "correctness-1",
      reviewer: "correctness",
      bundle: "b",
      files: ["a"],
    });
    now = 500;
    vi.advanceTimersByTime(1000);
    expect(lines).toHaveLength(1);

    now = 2600;
    vi.advanceTimersByTime(1000);
    expect(lines.at(-1)).toBe("[ocra] Model is thinking... (3s since last update)\n");

    printer.stop();
    now = 10_000;
    vi.advanceTimersByTime(5000);
    expect(lines).toHaveLength(2);
    vi.useRealTimers();
  });

  it("describes failed tasks with their error", () => {
    const lines: string[] = [];
    const printer = new ProgressPrinter(
      { write: (l: string) => lines.push(l) },
      { heartbeatMs: 1e9, now: () => 0 },
    );
    printer.onEvent({
      type: "task_finished",
      outcome: {
        taskId: "correctness-1",
        reviewer: "correctness",
        bundle: "b",
        files: [],
        status: "timed_out",
        error: "timed out after 600000ms",
        findings: 0,
        durationMs: 600_000,
      },
    });
    printer.stop();
    expect(lines).toEqual([
      "[ocra] correctness-1 timed out after 600.0s: timed out after 600000ms\n",
    ]);
  });
});
