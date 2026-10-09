import { roleCall } from "../agent/settings.js";
import { type Bundle, bundleFiles, defaultBundlePolicy } from "../bundle/bundle.js";
import { runtimeGrouper } from "../bundle/runtime-grouper.js";
import type { AgentRuntime, ReviewContext, Usage } from "../contracts.js";
import type { ChangeRequest, FileDiff, PriorReview, RiskTier } from "../domain.js";
import { errorMessage } from "../errors.js";
import { rank } from "../matrix/matrix.js";
import { MEMORY_PATH, mergeMemory, parseMemory, type RememberedEntry } from "../memory/memory.js";
import type { ReviewEvent, ReviewReport } from "../report/report.js";
import {
  parseRepoRules,
  REPO_RULES_PATH,
  type RepoRule,
  type SourcedRule,
} from "../rules/repo-rules.js";
import {
  binaryTextWarning,
  defaultSelectionPolicy,
  type FileDecision,
  selectFiles,
} from "../select/select.js";
import { triage } from "../triage.js";
import type { VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import type { ReviewHooks, ReviewOptions } from "./options.js";
import { resumedBundles } from "./resume.js";
import { newRunId } from "./run-id.js";

const GUIDELINES_PATH = "AGENTS.md";

// Everything the deterministic stages decide before any reviewer runs.
export interface ReviewPlan {
  changeRequest: ChangeRequest;
  decisions: FileDecision[];
  selected: FileDiff[];
  tier: RiskTier;
  bundles: Bundle[];
  // Selected files left out because an earlier review covered them unchanged.
  unchanged: ReadonlySet<string>;
  // The prior review, and the warning when it could not be read.
  prior: { review?: PriorReview; warning?: string };
  // Incremental, or full and why, when there is a prior review; an
  // incremental review becomes a full one when the risk tier rose.
  scope?: ReviewScope;
  context: ReviewContext;
  guidelines: string | undefined;
  repoRules: SourcedRule[];
  memory: RememberedEntry[];
  usage: Usage[];
  warnings: string[];
}

// Planning needs no model except for grouping, which is skipped without a runtime.
export type PlanOptions = Pick<
  ReviewOptions & ReviewHooks,
  | "vcs"
  | "rules"
  | "readTrusted"
  | "accountMemory"
  | "selection"
  | "bundling"
  | "grouper"
  | "effort"
  | "roles"
  | "resume"
> & {
  // Absent for a plan preview, which nobody looks up again.
  runId?: string;
  runtime?: AgentRuntime;
  // Review every file even when the prior review says what changed since.
  full?: boolean;
};

type ReviewScope = NonNullable<ReviewReport["scope"]>;

export async function planReview(
  options: PlanOptions,
  emit: (event: ReviewEvent) => void,
  signal: AbortSignal,
): Promise<ReviewPlan> {
  const { vcs } = options;
  const readTrusted = options.readTrusted ?? ((path: string) => vcs.readFile(path));
  const prior = await loadPriorReview(vcs);
  const scope = reviewScope(prior.review, options.full === true);
  const changeRequest = await vcs.getChangeRequest();
  emit({ type: "run_started", runId: options.runId ?? newRunId(), changeRequest });

  const diffs = await vcs.getDiff();
  const decisions = selectFiles(diffs, { ...defaultSelectionPolicy, ...options.selection });
  const selected = decisions.filter((d) => d.selected).map((d) => d.diff);
  const tier = triage(selected);
  emit({
    type: "files_selected",
    selected: selected.length,
    excluded: diffs.length - selected.length,
    tier,
  });

  const [guidelines, fileRules, memoryText] = await Promise.all([
    readTrusted(GUIDELINES_PATH),
    loadRepoRules(readTrusted),
    readTrusted(MEMORY_PATH),
  ]);
  const usage: Usage[] = [];
  const grouper =
    options.grouper ??
    (options.runtime
      ? runtimeGrouper(options.runtime, signal, (u) => usage.push(u), roleCall("helper", options))
      : undefined);
  // The rest of the change still sets the risk tier; a tier above the prior
  // review's adds reviewers, so everything is reviewed again.
  const priorTier = prior.review?.tier;
  const widened =
    scope.only && priorTier && rank(tier) > rank(priorTier)
      ? { from: priorTier, to: tier }
      : undefined;
  const only = widened ? undefined : scope.only;
  const inScope = only
    ? selected.filter((d) => only.has(d.newPath) || only.has(d.oldPath))
    : selected;
  const unchanged = new Set(selected.filter((d) => !inScope.includes(d)).map((d) => d.newPath));
  const resumed = options.resume && resumedBundles(options.resume, inScope);
  const bundled = resumed
    ? { bundles: resumed, strategy: "resumed", warnings: [] }
    : await bundleFiles(inScope, options.bundling ?? defaultBundlePolicy, grouper);
  emit({
    type: "files_bundled",
    strategy: bundled.strategy,
    bundles: bundled.bundles.length,
    groups: bundled.bundles.map((b) => ({ label: b.label, files: b.files.map((f) => f.newPath) })),
    warnings: bundled.warnings,
  });

  const binaryText = binaryTextWarning(decisions);
  return {
    changeRequest,
    decisions,
    selected,
    tier,
    bundles: bundled.bundles,
    unchanged,
    prior,
    ...(widened
      ? {
          scope: {
            mode: "full",
            reason: `the risk tier rose from ${widened.from} to ${widened.to}, which adds reviewers`,
          },
        }
      : scope.note
        ? { scope: scope.note }
        : {}),
    context: reviewContext(vcs, diffs),
    guidelines,
    repoRules: [
      ...(options.rules ?? []),
      ...fileRules.map((rule): SourcedRule => ({ ...rule, source: "repository" })),
    ],
    memory: mergeMemory(
      memoryText === undefined ? [] : parseMemory(memoryText),
      options.accountMemory ?? [],
    ),
    usage,
    warnings: binaryText ? [binaryText, ...bundled.warnings] : bundled.warnings,
  };
}

async function loadRepoRules(
  read: (path: string) => Promise<string | undefined>,
): Promise<RepoRule[]> {
  const text = await read(REPO_RULES_PATH);
  return text === undefined ? [] : parseRepoRules(text);
}

// Review only what changed since the prior review when the platform can
// tell; otherwise everything, with the reason in the report.
function reviewScope(
  review: PriorReview | undefined,
  full: boolean,
): { only?: ReadonlySet<string>; note?: ReviewScope } {
  if (!review) return {};
  if (full) return { note: { mode: "full", reason: "a full review was requested" } };
  if (review.changedSince) {
    return {
      only: new Set(review.changedSince.files),
      note: { mode: "incremental", since: review.changedSince.head },
    };
  }
  const reason = review.fullReviewReason ?? "the platform cannot tell what changed since";
  return { note: { mode: "full", reason } };
}

// A missing prior review only costs the comparison, never the review.
async function loadPriorReview(
  vcs: VcsAdapter,
): Promise<{ review?: PriorReview; warning?: string }> {
  try {
    const review = await vcs.getPriorReview();
    return review ? { review } : {};
  } catch (error) {
    return { warning: `could not load the previous review: ${errorMessage(error)}` };
  }
}
