import { roleCall } from "../agent/settings.js";
import { type Bundle, bundleFiles, defaultBundlePolicy } from "../bundle/bundle.js";
import { runtimeGrouper } from "../bundle/runtime-grouper.js";
import type { AgentRuntime, ReviewContext, Usage } from "../contracts.js";
import type { ChangeRequest, FileDiff, RiskTier } from "../domain.js";
import { MEMORY_PATH, mergeMemory, parseMemory, type RememberedEntry } from "../memory/memory.js";
import type { ReviewEvent } from "../report/report.js";
import {
  parseRepoRules,
  REPO_RULES_PATH,
  type RepoRule,
  type SourcedRule,
} from "../rules/repo-rules.js";
import { defaultSelectionPolicy, type FileDecision, selectFiles } from "../select/select.js";
import { triage } from "../triage.js";
import { reviewContext } from "./context.js";
import { rank } from "./matrix.js";
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
  // Set when an incremental review became a full one because the tier rose.
  widened?: { from: RiskTier; to: RiskTier };
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
  // Review only these selected files (incremental re-review); the rest of the
  // change still sets the risk tier.
  reviewOnly?: ReadonlySet<string>;
  // The tier of the review reviewOnly continues; a higher one reviews all.
  priorTier?: RiskTier;
};

export async function planReview(
  options: PlanOptions,
  emit: (event: ReviewEvent) => void,
  signal: AbortSignal,
): Promise<ReviewPlan> {
  const { vcs } = options;
  const readTrusted = options.readTrusted ?? ((path: string) => vcs.readFile(path));
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
  const widened =
    options.reviewOnly && options.priorTier && rank(tier) > rank(options.priorTier)
      ? { from: options.priorTier, to: tier }
      : undefined;
  const only = widened ? undefined : options.reviewOnly;
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

  return {
    changeRequest,
    decisions,
    selected,
    tier,
    bundles: bundled.bundles,
    unchanged,
    ...(widened ? { widened } : {}),
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
    warnings: bundled.warnings,
  };
}

async function loadRepoRules(
  read: (path: string) => Promise<string | undefined>,
): Promise<RepoRule[]> {
  const text = await read(REPO_RULES_PATH);
  return text === undefined ? [] : parseRepoRules(text);
}
