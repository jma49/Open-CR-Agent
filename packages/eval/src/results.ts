import { readFile } from "node:fs/promises";
import { errorMessage, reportOutputSchema } from "@open-cr-agent/core";
import { isNotFound } from "@open-cr-agent/core/internal";
import { z } from "zod";

const report = reportOutputSchema.shape;

export const instanceStatusSchema = z.enum([
  "reviewed",
  "failed",
  "unavailable",
  "skipped_budget",
  "skipped_quota",
]);
export type InstanceStatus = z.output<typeof instanceStatusSchema>;

// One PR's result in a run directory (instances/<id>.json): what scoring
// reads of ocra's report, and how the run went. Results are read back to
// resume and to rescore, so they are validated like any file on disk.
export const instanceResultSchema = z.strictObject({
  id: z.string(),
  status: instanceStatusSchema,
  durationMs: z.number(),
  findings: report.findings,
  // How ocra anchored the findings; absent in results written before it
  // was published.
  anchoring: report.anchoring,
  usage: report.usage,
  tasks: z.array(report.tasks.element.pick({ taskId: true, status: true, error: true })),
  // The CLI's exit code; 3 means the review was incomplete.
  exitCode: z.int().exactOptional(),
  // Absent in results written before it was recorded.
  verdict: report.verdict.exactOptional(),
  // What the review was made with (ocra's report); absent before ocra
  // recorded it.
  provenance: report.provenance,
  error: z.string().exactOptional(),
});
export type InstanceResult = z.output<typeof instanceResultSchema>;

// Undefined when the PR has no result yet; a result that cannot be read is
// an error naming the file and why.
export async function readResult(path: string): Promise<InstanceResult | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  try {
    return instanceResultSchema.parse(JSON.parse(text));
  } catch (error) {
    throw new Error(`${path} is not a result ocra-eval wrote: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}
