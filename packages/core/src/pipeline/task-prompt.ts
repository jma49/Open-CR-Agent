import type { Bundle } from "../bundle/bundle.js";
import { type GuidelineScope, guidelinesForTask, type TaskGuidelines } from "../docs/guidelines.js";
import { sectionsFor } from "../docs/project-docs.js";
import type { FindingRule } from "../domain.js";
import type { MatrixCell } from "../matrix/matrix.js";
import { memoryFor } from "../memory/memory.js";
import type { OptionalContext } from "../review/context-sources.js";
import { buildReviewPrompt, type ReviewPrompt, type ReviewPromptInput } from "../review/prompt.js";
import { resolveRepoRules, resolveRules } from "../rules/resolve.js";
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
  // What a finding of the task may name as the rule it applies: the
  // repository rules and the learnings, read or listed, it was given.
  citable: ReadonlyMap<string, FindingRule["kind"]>;
  // The plan phase's call, when the task has one: one per reviewer and
  // bundle (key), shared by --ultra's two samples, so its prompt is built
  // only by the call that runs it.
  planCall?: { key: string; prompt: () => ReviewPrompt };
}

export interface TaskSettings {
  ultra: boolean;
  // Sources an ablation run leaves out of every prompt (ADR-0057).
  without?: ReadonlySet<OptionalContext>;
  // Which guideline sections each task is given (ADR-0059); "all" unless set.
  guidelineScope?: GuidelineScope;
  // The files a security reviewer reviews in the run (securityReviewed).
  securityFiles: ReadonlySet<string>;
}

// What one task of the matrix sends: the run builds its prompt from this and
// --plan previews it, so the preview cannot drift from the run.
export function taskPrompt(
  cell: MatrixCell,
  plan: ReviewPlan,
  { ultra, securityFiles, without, guidelineScope = "all" }: TaskSettings,
): TaskPrompt {
  const files = cell.bundle.files.map((f) => f.newPath);
  const learnings = plan.learnings(cell.bundle.files);
  const repoRules = resolveRepoRules(files, plan.repoRules);
  const docs = sectionsFor(plan.docSections, files);
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
    rules: resolveRules(files, cell.reviewer.rules),
    repoRules: repoRules.text,
    ...guidelinesInput(
      guidelinesForTask(
        plan.guidelineSections,
        guidelineScope,
        files,
        cell.reviewer.scope?.requiresGuidelines === true,
      ),
    ),
    ...(plan.linkedTasks && plan.linkedTasks.given.length > 0
      ? { linkedTasks: plan.linkedTasks.given }
      : {}),
    accepted: memoryFor(files, plan.memory),
    learnings: learnings.selected,
    moreLearnings: learnings.left,
    ...(docs.given.length > 0 ? { projectDocs: docs } : {}),
    ...(analyzerResults.length > 0 ? { analyzerResults } : {}),
    ...(without && without.size > 0 ? { without } : {}),
  };
  const prompt = buildReviewPrompt(input);
  const callers = (ultra || plan.tier === "full") && !without?.has("callers");
  const citable = citableRules(
    without?.has("rules") ? [] : repoRules.ids,
    without?.has("learnings") ? [] : [...learnings.selected, ...learnings.left],
  );
  if (!ultra && !plansFirst(cell)) return { input, prompt, callers, citable };
  return {
    input,
    prompt,
    callers,
    citable,
    planCall: {
      key: `${cell.reviewer.id}\0${cell.bundle.label}`,
      prompt: () => buildReviewPrompt({ ...input, planPhase: "call" }),
    },
  };
}

function guidelinesInput(
  guidelines: TaskGuidelines | undefined,
): Pick<ReviewPromptInput, "guidelines" | "moreGuidelines"> {
  if (!guidelines) return {};
  return {
    guidelines: guidelines.text,
    ...(guidelines.left.length > 0 ? { moreGuidelines: guidelines.left } : {}),
  };
}

// A checklist orders a reviewer's steps inside one large bundle. A reviewer
// that takes the change as a whole is over the size on most changes, and
// its plan calls were a tenth of a review's bill for no finding more.
function plansFirst({ reviewer, bundle }: MatrixCell): boolean {
  return (reviewer.scope?.span ?? "bundle") === "bundle" && isLargeBundle(bundle);
}

function isLargeBundle({ files }: Bundle): boolean {
  const chars = files.reduce((sum, f) => sum + f.patch.length, 0);
  return files.length >= PLAN_MIN_FILES || chars >= PLAN_MIN_PATCH_CHARS;
}

function citableRules(
  rules: readonly string[],
  learnings: readonly { id: string }[],
): ReadonlyMap<string, FindingRule["kind"]> {
  const citable = new Map<string, FindingRule["kind"]>();
  for (const l of learnings) citable.set(l.id, "learning");
  for (const id of rules) citable.set(id, "rule");
  return citable;
}
