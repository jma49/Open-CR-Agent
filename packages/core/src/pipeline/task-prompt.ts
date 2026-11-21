import type { Bundle } from "../bundle/bundle.js";
import type { MatrixCell } from "../matrix/matrix.js";
import { memoryFor } from "../memory/memory.js";
import { buildReviewPrompt, type ReviewPrompt, type ReviewPromptInput } from "../review/prompt.js";
import { resolveRules } from "../rules/resolve.js";
import { evidenceForReviewer } from "../sarif/evidence.js";
import type { ReviewPlan } from "./plan.js";

// In default mode only bundles large enough that a reviewer's 30 steps may
// not cover them get a plan phase; --ultra plans every task.
const PLAN_MIN_FILES = 5;
const PLAN_MIN_PATCH_CHARS = 40_000;

export interface TaskPrompt {
  // What the prompt is built from; a plan phase and the callers are added to
  // it before the task runs.
  input: ReviewPromptInput;
  // The first prompt, before a plan phase or callers.
  prompt: ReviewPrompt;
  // Whether the task is shown the callers of the symbols its bundle changes
  // (impact.ts): under --ultra, and at the full tier, where a change risky
  // enough to get every reviewer is most likely to break a caller the
  // reviewer would otherwise have to find with its own steps.
  callers: boolean;
  // The plan phase's call, when the task has one: one per reviewer and
  // bundle (key), shared by --ultra's two samples, so its prompt is built
  // only by the call that runs it.
  planCall?: { key: string; prompt: () => ReviewPrompt };
}

export interface TaskSettings {
  ultra: boolean;
  // The files a security reviewer reviews in the run (securityReviewed).
  securityFiles: ReadonlySet<string>;
}

// What one task of the matrix sends: the run builds its prompt from this and
// --plan previews it, so the preview cannot drift from the run.
export function taskPrompt(
  cell: MatrixCell,
  plan: ReviewPlan,
  { ultra, securityFiles }: TaskSettings,
): TaskPrompt {
  const files = cell.bundle.files.map((f) => f.newPath);
  const learnings = plan.learnings(cell.bundle.files);
  const analyzerResults = evidenceForReviewer(
    plan.evidence.forBundle(cell.bundle),
    cell.reviewer.category,
    securityFiles,
  );
  const input: ReviewPromptInput = {
    reviewer: cell.reviewer,
    changeRequest: plan.changeRequest,
    changedFiles: plan.selected,
    bundle: cell.bundle.files,
    rules: resolveRules(files, plan.repoRules, cell.reviewer.rules),
    guidelines: plan.guidelines,
    accepted: memoryFor(files, plan.memory),
    learnings: learnings.selected,
    moreLearnings: learnings.left,
    ...(analyzerResults.length > 0 ? { analyzerResults } : {}),
  };
  const prompt = buildReviewPrompt(input);
  const callers = ultra || plan.tier === "full";
  if (!ultra && !isLargeBundle(cell.bundle)) return { input, prompt, callers };
  return {
    input,
    prompt,
    callers,
    planCall: {
      key: `${cell.reviewer.id}\0${cell.bundle.label}`,
      prompt: () => buildReviewPrompt({ ...input, forPlanning: true }),
    },
  };
}

function isLargeBundle({ files }: Bundle): boolean {
  const chars = files.reduce((sum, f) => sum + f.patch.length, 0);
  return files.length >= PLAN_MIN_FILES || chars >= PLAN_MIN_PATCH_CHARS;
}
