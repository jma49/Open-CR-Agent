import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { readBoundedFile } from "../bounded-file.js";
import { reportedFindingSchema, type TaskFinding } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import type { ResumedRun, ResumedTask } from "../pipeline/resume.js";
import { boundFinding, MAX_FINDINGS_PER_TASK } from "../pipeline/task.js";
import { taskOutcomeSchema } from "../report/output-schema.js";
import { EVENTS_FILE } from "./jsonl.js";
import { unsealLine } from "./seal.js";

// A session log is bounded by the run's task and finding limits; anything
// far larger was not written by ocra.
const MAX_EVENTS_BYTES = 64 * 1024 * 1024;

const RUN_ID = /^[\w@-][\w.@-]*$/;

const reportedEventSchema = z.object({
  type: z.literal("task_reported"),
  taskId: z.string(),
  key: z.string(),
  findings: z.array(
    z.object({ reported: reportedFindingSchema, model: z.string().exactOptional() }),
  ),
});

const finishedEventSchema = z.object({
  type: z.literal("task_finished"),
  outcome: taskOutcomeSchema,
});

const bundledEventSchema = z.object({
  type: z.literal("files_bundled"),
  groups: z.array(z.object({ label: z.string(), files: z.array(z.string()) })),
});

// The completed tasks of an earlier run, from its session log, which a run
// killed before it finished still has. The session lives in the reviewed
// tree, where a change can bring one of its own: only lines sealed with this
// machine's key (seal.ts) are read, the rest is skipped and counted, and a
// log with no such line is refused. Sealed lines are still validated and
// bounded like a model's answer. The bundles come from the log too; report.json
// carries no seal.
export async function readResumedRun(
  sessionsDir: string,
  runId: string,
  sealKey: string,
  warn: (message: string) => void = () => {},
): Promise<ResumedRun> {
  if (!RUN_ID.test(runId)) {
    throw new OcraError("INPUT_INVALID", `--resume: ${JSON.stringify(runId)} is not a run id`);
  }
  const dir = join(sessionsDir, runId);
  for (const path of [dirname(sessionsDir), sessionsDir, dir]) await refuseLink(path, runId);
  const text = await readEvents(join(dir, EVENTS_FILE), runId);
  const reported = new Map<string, z.infer<typeof reportedEventSchema>>();
  let groups: ResumedRun["bundles"] = [];
  const finished = new Map<string, z.infer<typeof finishedEventSchema>["outcome"]>();
  let sealed = 0;
  let unsealed = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const line = unsealLine(sealKey, runId, raw);
    if (line === undefined) {
      unsealed += 1;
      continue;
    }
    sealed += 1;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      continue;
    }
    const r = reportedEventSchema.safeParse(data);
    if (r.success) reported.set(r.data.taskId, r.data);
    const f = finishedEventSchema.safeParse(data);
    if (f.success) finished.set(f.data.outcome.taskId, f.data.outcome);
    const b = bundledEventSchema.safeParse(data);
    if (b.success) groups = b.data.groups;
  }
  if (sealed === 0) {
    throw new OcraError(
      "INPUT_INVALID",
      `--resume: the session of ${runId} was not written by ocra on this machine, so none of it is reused`,
    );
  }
  if (unsealed > 0) {
    warn(
      `--resume: ignored ${unsealed} line(s) of the session of ${runId} that ocra on this machine did not write`,
    );
  }
  const tasks: ResumedTask[] = [];
  for (const [taskId, outcome] of finished) {
    const event = reported.get(taskId);
    if (!event || !reusable(outcome)) continue;
    tasks.push({ key: event.key, outcome, findings: bounded(event.findings) });
  }
  return { runId, bundles: groups, tasks };
}

// Only a task that finished its review, with a plausible outcome: one cut
// off before it finished is reviewed again (ADR-0030).
function reusable(outcome: z.infer<typeof taskOutcomeSchema>): boolean {
  const { usage } = outcome;
  return (
    outcome.status === "completed" &&
    outcome.ended === undefined &&
    (outcome.reusedFrom === undefined || RUN_ID.test(outcome.reusedFrom)) &&
    outcome.durationMs >= 0 &&
    Object.values(usage).every((n) => Number.isFinite(n) && n >= 0)
  );
}

// The same bounds a live task's findings get, so a session written by hand
// cannot bring in more or longer findings than a model could.
function bounded(
  findings: readonly z.infer<typeof reportedEventSchema>["findings"][number][],
): TaskFinding[] {
  return findings.slice(0, MAX_FINDINGS_PER_TASK).map(({ reported, model }) => ({
    reported: boundFinding(reported),
    ...(model === undefined ? {} : { model }),
  }));
}

async function readEvents(path: string, runId: string): Promise<string> {
  try {
    return await readBoundedFile(path, { maxBytes: MAX_EVENTS_BYTES, followLinks: false });
  } catch (error) {
    if (error instanceof OcraError) {
      throw new OcraError(error.code, `--resume: the session log of ${runId}: ${error.message}`, {
        cause: error,
      });
    }
    throw new OcraError(
      "INPUT_INVALID",
      `--resume: no session log for run ${runId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

// Like the writer, follow no link planted in the reviewed tree to make
// another directory read as this run's.
async function refuseLink(path: string, runId: string): Promise<void> {
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) {
    throw new OcraError(
      "ACCESS_DENIED",
      `--resume: the session of ${runId} is reached through the symbolic link ${path}`,
    );
  }
}
