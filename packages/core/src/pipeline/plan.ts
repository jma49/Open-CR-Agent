import { type Bundle, bundleFiles, defaultBundlePolicy } from "../bundle/bundle.js";
import type { ReviewContext, Usage, VcsAdapter } from "../contracts.js";
import type { ChangeRequest, FileDiff, RiskTier } from "../domain.js";
import { parseRepoRules, REPO_RULES_PATH, type RepoRule } from "../rules/repo-rules.js";
import { defaultSelectionPolicy, type FileDecision, selectFiles } from "../select/select.js";
import { triage } from "../triage.js";
import { reviewContext } from "./context.js";
import { runtimeGrouper } from "./helpers.js";
import type { ReviewEvent } from "./report.js";
import type { ReviewOptions } from "./run.js";

export const GUIDELINES_PATH = "AGENTS.md";

// Everything the deterministic stages decide before any reviewer runs.
export interface ReviewPlan {
  changeRequest: ChangeRequest;
  decisions: FileDecision[];
  selected: FileDiff[];
  tier: RiskTier;
  bundles: Bundle[];
  context: ReviewContext;
  guidelines: string | undefined;
  repoRules: RepoRule[];
  usage: Usage[];
  warnings: string[];
}

export async function planReview(
  options: ReviewOptions,
  emit: (event: ReviewEvent) => void,
  signal: AbortSignal,
): Promise<ReviewPlan> {
  const { vcs } = options;
  const changeRequest = await vcs.getChangeRequest();
  emit({ type: "run_started", changeRequest });

  const diffs = await vcs.getDiff();
  const decisions = selectFiles(diffs, options.selection ?? defaultSelectionPolicy);
  const selected = decisions.filter((d) => d.selected).map((d) => d.diff);
  const tier = triage(selected);
  emit({
    type: "files_selected",
    selected: selected.length,
    excluded: diffs.length - selected.length,
    tier,
  });

  const [guidelines, fileRules] = await Promise.all([
    vcs.readFile(GUIDELINES_PATH),
    loadRepoRules(vcs),
  ]);
  const usage: Usage[] = [];
  const grouper = options.grouper ?? runtimeGrouper(options.runtime, signal, (u) => usage.push(u));
  const bundled = await bundleFiles(selected, options.bundling ?? defaultBundlePolicy, grouper);
  emit({
    type: "files_bundled",
    strategy: bundled.strategy,
    bundles: bundled.bundles.length,
    warnings: bundled.warnings,
  });

  return {
    changeRequest,
    decisions,
    selected,
    tier,
    bundles: bundled.bundles,
    context: reviewContext(vcs, diffs),
    guidelines,
    repoRules: [...(options.rules ?? []), ...fileRules],
    usage,
    warnings: bundled.warnings,
  };
}

async function loadRepoRules(vcs: VcsAdapter): Promise<RepoRule[]> {
  const text = await vcs.readFile(REPO_RULES_PATH);
  return text === undefined ? [] : parseRepoRules(text);
}
