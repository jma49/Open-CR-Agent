import { z } from "zod";
import { readBoundedFile } from "../bounded-file.js";
import { errorMessage, OcraError } from "../errors.js";
import type { ReportOutput } from "./output.js";
import { REPORT_VERSION, reportOutputSchema } from "./output-schema.js";

// Far above what a run's task and finding limits let a report reach; a
// session's report.json lives in the reviewed tree, which may hold anything.
const MAX_REPORT_BYTES = 64 * 1024 * 1024;

// A JSON report from disk, as ocra wrote it (--format json, a session's
// report.json). Anything else is an INPUT_INVALID error saying why, with the
// read or parse error as its cause; a caller that may skip a report decides
// what to say about it.
export async function readReport(path: string): Promise<ReportOutput> {
  let text: string;
  try {
    text = await readBoundedFile(path, { maxBytes: MAX_REPORT_BYTES, followLinks: true });
  } catch (error) {
    throw new OcraError("INPUT_INVALID", `cannot read ${path}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new OcraError("INPUT_INVALID", `${path} is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const parsed = reportOutputSchema.safeParse(data);
  if (!parsed.success) {
    throw new OcraError(
      "INPUT_INVALID",
      `${path} is not a version ${REPORT_VERSION} ocra report: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
