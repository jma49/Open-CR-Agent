import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { reportedFindingSchema } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import type { ResumedRun, ResumedTask } from "../pipeline/resume.js";
import { taskOutcomeSchema } from "../report/output-schema.js";
import { readReport } from "../report/read.js";
import { EVENTS_FILE, REPORT_FILE } from "./jsonl.js";

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

// The completed tasks of an earlier run, from its session log, which a run
// killed before it finished still has. The session lives in the reviewed
// tree, so every line is validated; a line that is not a task event this
// reads is skipped. Its bundles come from report.json when the run got that far.
export async function readResumedRun(sessionsDir: string, runId: string): Promise<ResumedRun> {
  if (!RUN_ID.test(runId)) {
    throw new OcraError("INPUT_INVALID", `--resume: ${JSON.stringify(runId)} is not a run id`);
  }
  const dir = join(sessionsDir, runId);
  const text = await readEvents(join(dir, EVENTS_FILE), runId);
  const reported = new Map<string, z.infer<typeof reportedEventSchema>>();
  const finished = new Map<string, z.infer<typeof finishedEventSchema>["outcome"]>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
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
  }
  const tasks: ResumedTask[] = [];
  for (const [taskId, outcome] of finished) {
    const event = reported.get(taskId);
    if (outcome.status !== "completed" || !event) continue;
    tasks.push({ key: event.key, outcome, findings: event.findings });
  }
  const report = await readReport(join(dir, REPORT_FILE)).catch(() => undefined);
  return { runId, bundles: report?.bundles ?? [], tasks };
}

async function readEvents(path: string, runId: string): Promise<string> {
  try {
    const { size } = await stat(path);
    if (size > MAX_EVENTS_BYTES) {
      throw new OcraError("INPUT_INVALID", `--resume: the session log of ${runId} is too large`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof OcraError) throw error;
    throw new OcraError(
      "INPUT_INVALID",
      `--resume: no session log for run ${runId}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}
