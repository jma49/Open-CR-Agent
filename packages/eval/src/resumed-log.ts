import { z } from "zod";

// A resumed review does not run the tasks it reuses again, so its session log
// lacks what they read and raised. Those events are carried over from the
// log of the attempts it resumed; nothing else of theirs is, since the rest
// (other tasks, Verify, the judge, the report) is what this review did again.

const eventSchema = z.looseObject({
  type: z.string(),
  taskId: z.string().optional(),
  key: z.string().optional(),
  outcome: z.looseObject({ taskId: z.string(), reusedFrom: z.string().optional() }).optional(),
});
type Event = z.infer<typeof eventSchema>;

interface Line {
  text: string;
  event: Event | undefined;
}

/**
 * The lines of `earlier` (the attempts resumed, one run_started each) that
 * belong to a task `current` reused, with the run_started lines of their
 * attempts; empty when it reused none.
 */
export function carriedEvents(earlier: string, current: string): string {
  const reused = reusedKeys(lines(current));
  if (reused.size === 0) return "";
  return attempts(lines(earlier))
    .flatMap((attempt) => {
      const tasks = new Set(
        attempt.flatMap(({ event }) =>
          event?.type === "task_reported" && event.taskId && reused.has(event.key ?? "")
            ? [event.taskId]
            : [],
        ),
      );
      if (tasks.size === 0) return [];
      return attempt.filter(
        ({ event }) => event?.type === "run_started" || tasks.has(taskOf(event) ?? ""),
      );
    })
    .map(({ text }) => `${text}\n`)
    .join("");
}

// The keys of the task inputs a review took from an earlier run.
function reusedKeys(log: readonly Line[]): Set<string> {
  const reusedTasks = new Set(
    log.flatMap(({ event }) =>
      event?.type === "task_finished" && event.outcome?.reusedFrom !== undefined
        ? [event.outcome.taskId]
        : [],
    ),
  );
  return new Set(
    log.flatMap(({ event }) =>
      event?.type === "task_reported" && event.key && reusedTasks.has(event.taskId ?? "")
        ? [event.key]
        : [],
    ),
  );
}

function taskOf(event: Event | undefined): string | undefined {
  return event?.taskId ?? event?.outcome?.taskId;
}

// Task ids are per run, so each attempt in the log is read on its own.
function attempts(log: readonly Line[]): Line[][] {
  const result: Line[][] = [];
  for (const line of log) {
    const last = result.at(-1);
    if (line.event?.type === "run_started" || !last) result.push([line]);
    else last.push(line);
  }
  return result;
}

// A line that is not an event (one cut short when a process died) is kept as
// text with no event, so it is never carried.
function lines(text: string): Line[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => ({ text: line, event: parse(line) }));
}

function parse(line: string): Event | undefined {
  try {
    return eventSchema.safeParse(JSON.parse(line)).data;
  } catch {
    return undefined;
  }
}
