import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type GoldenCase, parseCase, readJson } from "./golden.js";
import type { GoldenFinding } from "./golden-score.js";

export const LABELS_FILE = "adjudication.json";

// The maintainer edits this file in the run directory: each entry gets
// "valid" or "invalid" and a one-line reason, then `ocra-eval adjudicate`
// records the labels in the cases. No interactive prompt.
const entrySchema = z.object({
  case: z.string(),
  fingerprint: z.string(),
  category: z.string(),
  severity: z.enum(["critical", "warning", "suggestion"]),
  file: z.string(),
  lines: z.object({ start: z.number(), end: z.number() }).optional(),
  title: z.string(),
  body: z.string(),
  label: z.enum(["valid", "invalid"]).nullable(),
  reason: z.string(),
});
const labelsSchema = z.object({ goldenDir: z.string(), entries: z.array(entrySchema) });

export type LabelEntry = z.infer<typeof entrySchema>;
export type LabelsFile = z.infer<typeof labelsSchema>;

const CASE_CATEGORIES = new Set(["correctness", "security", "performance"]);

// Rescoring a run keeps the labels already typed into its file.
export function labelsFor(
  goldenDir: string,
  unadjudicated: readonly GoldenFinding[],
  previous?: LabelsFile,
): LabelsFile {
  const earlier = new Map(previous?.entries.map((e) => [`${e.case}/${e.fingerprint}`, e]));
  return {
    goldenDir,
    entries: unadjudicated.map((f) => {
      const old = earlier.get(`${f.case}/${f.fingerprint}`);
      return { ...f, label: old?.label ?? null, reason: old?.reason ?? "" };
    }),
  };
}

export async function readLabels(runDir: string): Promise<LabelsFile | undefined> {
  const path = join(runDir, LABELS_FILE);
  let data: unknown;
  try {
    data = await readJson(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const result = labelsSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${path}: ${issue?.path.join(".") || "file"}: ${issue?.message}`);
  }
  return result.data;
}

export interface ApplyResult {
  applied: number;
  pending: number;
  alreadyRecorded: number;
}

// A valid finding also becomes an expect entry, at the lowest severity, so a
// later run is scored on it; the maintainer can raise the severity by hand.
// Every case is updated and validated before any file is written.
export async function applyLabels(labels: LabelsFile, goldenDir: string): Promise<ApplyResult> {
  const result: ApplyResult = { applied: 0, pending: 0, alreadyRecorded: 0 };
  const ready = labels.entries.filter((e) => {
    const labeled = e.label !== null && e.reason.trim() !== "";
    if (!labeled) result.pending += 1;
    return labeled;
  });
  const updates: { path: string; golden: GoldenCase }[] = [];
  for (const caseId of new Set(ready.map((e) => e.case))) {
    if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(caseId)) throw new Error(`invalid case id "${caseId}"`);
    const path = join(goldenDir, `${caseId}.json`);
    const golden: GoldenCase = parseCase(await readJson(path), path);
    const known = new Set(golden.adjudicated.map((a) => a.fingerprint));
    for (const entry of ready.filter((e) => e.case === caseId)) {
      if (known.has(entry.fingerprint)) {
        result.alreadyRecorded += 1;
        continue;
      }
      known.add(entry.fingerprint);
      const label = entry.label as "valid" | "invalid";
      if (label === "valid" && golden.clean && !entry.lines) {
        throw new Error(
          `${path}: "${entry.title}" is labeled valid on a clean case but has no lines to expect; add an expect entry by hand and set clean to false, or label it invalid`,
        );
      }
      golden.adjudicated.push({
        fingerprint: entry.fingerprint,
        label,
        reason: entry.reason.trim(),
        title: entry.title,
      });
      if (label === "valid" && entry.lines) {
        // A real issue on a case thought clean means the case was not clean.
        golden.clean = false;
        golden.expect.push({
          file: entry.file,
          lines: [entry.lines.start, entry.lines.end],
          category: (CASE_CATEGORIES.has(entry.category)
            ? entry.category
            : "correctness") as GoldenCase["expect"][number]["category"],
          minSeverity: "suggestion",
          concern: entry.title,
          also: [],
        });
      }
      result.applied += 1;
    }
    // Validate what is written exactly as a load would.
    updates.push({ path, golden: parseCase(golden, path) });
  }
  for (const { path, golden } of updates) {
    await writeFile(path, `${JSON.stringify(golden, null, 2)}\n`);
  }
  return result;
}
