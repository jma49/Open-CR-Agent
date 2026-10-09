import type { Bundle } from "../bundle/bundle.js";
import type { MatrixCell } from "../matrix/matrix.js";
import { memoryFor } from "../memory/memory.js";
import { buildReviewPrompt, type ReviewPrompt, type ReviewPromptInput } from "../review/prompt.js";
import { resolveRules } from "../rules/resolve.js";
import type { ReviewPlan } from "./plan.js";

// In default mode only bundles large enough that a reviewer's 30 steps may
// not cover them get a plan phase; --ultra plans every task.
const PLAN_MIN_FILES = 5;
const PLAN_MIN_PATCH_CHARS = 40_000;

export interface TaskPrompt {
  // What the prompt is built from; a plan phase and --ultra's callers are
  // added to it before the task runs.
  input: ReviewPromptInput;
  // The first prompt, before a plan phase or callers.
  prompt: ReviewPrompt;
  // The plan phase's call, when the task has one: one per reviewer and
  // bundle (key), shared by --ultra's two samples, so its prompt is built
  // only by the call that runs it.
  planCall?: { key: string; prompt: () => ReviewPrompt };
}

// What one task of the matrix sends: the run builds its prompt from this and
// --plan previews it, so the preview cannot drift from the run.
export function taskPrompt(cell: MatrixCell, plan: ReviewPlan, ultra: boolean): TaskPrompt {
  const files = cell.bundle.files.map((f) => f.newPath);
  const input: ReviewPromptInput = {
    reviewer: cell.reviewer,
    changeRequest: plan.changeRequest,
    changedFiles: plan.selected,
    bundle: cell.bundle.files,
    rules: resolveRules(files, plan.repoRules, cell.reviewer.rules),
    guidelines: plan.guidelines,
    accepted: memoryFor(files, plan.memory),
  };
  const prompt = buildReviewPrompt(input);
  if (!ultra && !isLargeBundle(cell.bundle)) return { input, prompt };
  return {
    input,
    prompt,
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
