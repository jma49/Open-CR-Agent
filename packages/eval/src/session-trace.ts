import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { errorMessage, type OutputFinding } from "@open-cr-agent/core";
import { isNotFound, severitySchema } from "@open-cr-agent/core/internal";
import { z } from "zod";

// What a review's session log (events.jsonl) says about the way to its
// report: what its tasks read, what they reported, and what the run then
// took out. The recall funnel (funnel.ts) is read from it.

// Where the run took a reported finding out: Filter (memory), Verify, the
// judge, or the task itself, for a finding on a file outside its bundle.
export const DROP_STAGES = ["outside_bundle", "filter", "verify", "judge"] as const;
export type DropStage = (typeof DROP_STAGES)[number];

export interface SessionTrace {
  // Paths any attempt passed to read_file, normalized.
  read: Set<string>;
  // Every finding a task reported, in the shape matching reads.
  raised: (MatchableFinding & { fingerprint: string })[];
  // Findings dropped before they became one, by file and title only.
  outsideBundle: MatchableFinding[];
  // Fingerprints of reported findings a later stage took out.
  removed: Map<string, Exclude<DropStage, "outside_bundle">>;
}

export type MatchableFinding = Pick<
  OutputFinding,
  "file" | "lines" | "title" | "body" | "severity"
>;

// Only the events and fields the funnel reads; the rest of the log is not
// this reader's contract. Loose objects, so a field core adds later passes.
const fingerprints = z.array(z.object({ fingerprint: z.string() }));
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task_progress"),
    attempt: z.object({ read: z.array(z.string()) }).optional(),
  }),
  z.object({
    type: z.literal("finding"),
    finding: z.object({
      fingerprint: z.string(),
      file: z.string(),
      title: z.string(),
      body: z.string(),
      severity: severitySchema,
      lineRange: z.object({ start: z.int(), end: z.int() }).optional(),
    }),
  }),
  z.object({ type: z.literal("finding_dropped"), file: z.string(), title: z.string() }),
  z.object({ type: z.literal("verification_finished"), refuted: fingerprints }),
  z.object({
    type: z.literal("judge_finished"),
    judgement: z
      .object({ dropped: fingerprints, merged: z.array(z.object({ merged: z.array(z.string()) })) })
      .optional(),
  }),
  z.object({ type: z.literal("run_finished"), report: z.object({ remembered: fingerprints }) }),
]);
const READ = new Set<string>(eventSchema.options.map((o) => o.shape.type.value));

// Where a run keeps the session log of one PR's review (runner.ts).
export function sessionLogPath(runDir: string, id: string): string {
  return join(runDir, "events", `${id}.jsonl`);
}

// Undefined when the run kept no session log for the review.
export async function readSessionTrace(path: string): Promise<SessionTrace | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return traceOf(text);
  } catch (error) {
    throw new Error(`${path} is not a session log ocra wrote: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

function traceOf(text: string): SessionTrace {
  const trace: SessionTrace = {
    read: new Set(),
    raised: [],
    outsideBundle: [],
    removed: new Map(),
  };
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const json: unknown = JSON.parse(line);
    const type = z.object({ type: z.string() }).parse(json).type;
    if (!READ.has(type)) continue;
    const event = eventSchema.parse(json);
    switch (event.type) {
      case "task_progress":
        for (const path of event.attempt?.read ?? []) trace.read.add(normalizePath(path));
        break;
      case "finding": {
        const { lineRange, ...finding } = event.finding;
        trace.raised.push(lineRange ? { ...finding, lines: lineRange } : finding);
        break;
      }
      case "finding_dropped":
        // The log keeps no body or severity for these: matched on the title.
        trace.outsideBundle.push({
          file: event.file,
          title: event.title,
          body: "",
          severity: "suggestion",
        });
        break;
      case "verification_finished":
        for (const f of event.refuted) trace.removed.set(f.fingerprint, "verify");
        break;
      case "judge_finished":
        for (const f of event.judgement?.dropped ?? []) trace.removed.set(f.fingerprint, "judge");
        // A finding merged into another is gone from the report under its own
        // fingerprint; the one it went into may sit elsewhere.
        for (const m of event.judgement?.merged ?? []) {
          for (const fingerprint of m.merged) trace.removed.set(fingerprint, "judge");
        }
        break;
      case "run_finished":
        for (const f of event.report.remembered) trace.removed.set(f.fingerprint, "filter");
        break;
    }
  }
  return trace;
}

// A model chooses the path it reads: "./src/a.ts" is "src/a.ts".
export function normalizePath(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/"));
}
