import { describe, expect, it } from "vitest";
import { carriedEvents } from "./resumed-log.js";

const log = (...events: object[]) => events.map((e) => `${JSON.stringify(e)}\n`).join("");
const started = (runId: string) => ({ type: "run_started", runId });
const read = (taskId: string, path: string) => ({
  type: "task_progress",
  taskId,
  message: "",
  attempt: { read: [path] },
});
const reported = (taskId: string, key: string) => ({
  type: "task_reported",
  taskId,
  key,
  findings: [],
});
const reusedFrom = (taskId: string, runId: string) => ({
  type: "task_finished",
  outcome: { taskId, reusedFrom: runId },
});

const first = log(
  started("run-1"),
  read("perf-1", "src/perf.ts"),
  reported("perf-1", "k-perf"),
  read("logic-1", "src/lost.ts"),
  reported("logic-1", "k-logic"),
  { type: "run_finished", report: { remembered: [{ fingerprint: "f" }] } },
);

describe("carriedEvents", () => {
  it("carries only the reused tasks' events, with their attempt's start", () => {
    const current = log(
      started("run-2"),
      reported("perf-1", "k-perf"),
      reusedFrom("perf-1", "run-1"),
    );
    expect(carriedEvents(first, current)).toBe(
      log(started("run-1"), read("perf-1", "src/perf.ts"), reported("perf-1", "k-perf")),
    );
  });

  it("carries nothing when the review reused nothing", () => {
    const current = log(
      started("run-2"),
      read("perf-1", "src/again.ts"),
      reported("perf-1", "k-perf"),
    );
    expect(carriedEvents(first, current)).toBe("");
  });

  it("matches tasks by their inputs, not their ids, across every attempt resumed", () => {
    // run-2 reused run-1's perf task as perf-2; run-3 reuses it again as perf-3.
    const second = log(
      started("run-2"),
      reported("perf-2", "k-perf"),
      reusedFrom("perf-2", "run-1"),
      read("perf-1", "src/other.ts"),
      reported("perf-1", "k-other"),
    );
    const carried = carriedEvents(
      log(started("run-1"), read("perf-1", "src/perf.ts"), reported("perf-1", "k-perf")) + second,
      log(started("run-3"), reported("perf-3", "k-perf"), reusedFrom("perf-3", "run-1")),
    );
    expect(carried).toContain("src/perf.ts");
    expect(carried).toContain('"perf-2"');
    expect(carried).not.toContain("src/other.ts");
  });

  it("never carries a line that is not an event", () => {
    const current = log(
      started("run-2"),
      reported("perf-1", "k-perf"),
      reusedFrom("perf-1", "run-1"),
    );
    const carried = carriedEvents(`${first}{"type":"task_progress","taskId":"perf-1`, current);
    expect(
      carried
        .split("\n")
        .filter(Boolean)
        .every((line) => JSON.parse(line)),
    ).toBe(true);
  });
});
