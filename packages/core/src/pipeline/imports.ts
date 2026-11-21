import { emptyUsage } from "../agent/usage.js";
import { anchorFinding } from "../anchor/anchor.js";
import type { Finding, LineRange } from "../domain.js";
import type { ReviewEvent, TaskOutcome } from "../report/report.js";
import { type SarifCandidate, sarifCandidates } from "../sarif/candidates.js";
import { changedLines, overlaps } from "../sarif/evidence.js";
import type { SarifLog } from "../sarif/schema.js";
import { toFinding } from "./findings.js";
import type { ReviewPlan } from "./plan.js";
import { boundFinding } from "./task.js";

// Findings an external analyzer wrote as SARIF, brought into the review as
// one synthetic task per run of the log: no model, no spend, the tool as the
// reviewer. Only results on lines the change touches are kept; the rest of
// a whole-repository scan is not this change's to answer for. From here on
// they are findings like any other: memory, the previous review, Verify and
// the judge apply.

export interface SarifImport {
  findings: Finding[];
  outcomes: TaskOutcome[];
  warnings: string[];
}

// A hostile log could carry thousands of results on the change.
export const MAX_IMPORTED_PER_RUN = 200;

export async function importSarif(
  logs: readonly SarifLog[],
  plan: Pick<ReviewPlan, "selected" | "context">,
  emit: (event: ReviewEvent) => void,
): Promise<SarifImport> {
  const windows = changedLines(plan.selected);
  const imported: SarifImport = { findings: [], outcomes: [], warnings: [] };
  const counts = new Map<string, number>();
  for (const log of logs) {
    for (const run of log.runs) {
      const { tool, candidates, skipped } = sarifCandidates(run);
      const n = (counts.get(tool.slug) ?? 0) + 1;
      counts.set(tool.slug, n);
      const taskId = `sarif-${tool.slug}-${n}`;
      const started = Date.now();
      const onChange = candidates.filter((c) => touches(windows, c));
      const kept = onChange.slice(0, MAX_IMPORTED_PER_RUN);
      const files = [...new Set(kept.map((c) => c.file))];
      emit({ type: "task_started", taskId, reviewer: tool.slug, bundle: "sarif", files });
      let noCode = 0;
      const findings: Finding[] = [];
      for (const candidate of kept) {
        const finding = await toImportedFinding(candidate, tool.slug, taskId, plan);
        if (!finding) {
          noCode += 1;
          continue;
        }
        findings.push(finding);
        emit({ type: "finding", taskId, finding });
      }
      const outcome: TaskOutcome = {
        taskId,
        reviewer: tool.slug,
        bundle: "sarif",
        files,
        status: "completed",
        findings: findings.length,
        durationMs: Date.now() - started,
        usage: emptyUsage(),
      };
      emit({ type: "task_finished", outcome });
      imported.findings.push(...findings);
      imported.outcomes.push(outcome);
      imported.warnings.push(
        ...importWarnings(tool.name, {
          imported: findings.length,
          outside: candidates.length - onChange.length,
          overLimit: onChange.length - kept.length,
          noCode,
          ...skipped,
        }),
      );
    }
  }
  return imported;
}

async function toImportedFinding(
  candidate: SarifCandidate,
  reviewer: string,
  taskId: string,
  plan: Pick<ReviewPlan, "selected" | "context">,
): Promise<Finding | undefined> {
  const content = await plan.context.readFile(candidate.file).catch(() => undefined);
  const existingCode = candidate.snippet ?? quoteFrom(content, candidate.lines);
  if (!existingCode) return undefined;
  const reported = boundFinding({
    category: reviewer,
    severity: candidate.severity,
    file: candidate.file,
    existingCode,
    title: candidate.title,
    body: candidate.body,
    evidence: [],
  });
  // The tool's lines are not trusted over the quote: the same anchoring as
  // for a model's finding decides where the comment lands.
  const anchor = await anchorFinding(reported, {
    diffs: plan.selected,
    readNewFile: plan.context.readFile,
  });
  return toFinding(reported, reviewer, { task: taskId }, anchor, content);
}

function quoteFrom(content: string | undefined, lines: LineRange): string | undefined {
  if (content === undefined) return undefined;
  const quote = content
    .split("\n")
    .slice(lines.start - 1, lines.end)
    .join("\n")
    .trim();
  return quote || undefined;
}

function touches(windows: ReadonlyMap<string, LineRange[]>, candidate: SarifCandidate): boolean {
  return (windows.get(candidate.file) ?? []).some((r) => overlaps(candidate.lines, r, 0));
}

function importWarnings(
  tool: string,
  c: {
    imported: number;
    outside: number;
    overLimit: number;
    noCode: number;
    noLocation: number;
    unsupportedUri: number;
    noMessage: number;
  },
): string[] {
  const left: string[] = [];
  if (c.outside > 0) left.push(`${c.outside} outside the change`);
  if (c.overLimit > 0)
    left.push(`${c.overLimit} over the limit of ${MAX_IMPORTED_PER_RUN} per run`);
  if (c.noCode > 0) left.push(`${c.noCode} on lines that could not be read`);
  if (c.noLocation > 0) left.push(`${c.noLocation} without a file and lines`);
  if (c.unsupportedUri > 0) left.push(`${c.unsupportedUri} on paths outside the repository`);
  if (c.noMessage > 0) left.push(`${c.noMessage} without a message`);
  if (left.length === 0) return [];
  return [`${tool}: imported ${c.imported} result(s); left out ${left.join(", ")}`];
}
