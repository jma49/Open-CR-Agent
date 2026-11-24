import { z } from "zod";
import type { ReviewerOverrides, RoleSettings, TierEfforts } from "../agent/settings.js";
import type { AnchorContext } from "../anchor/anchor.js";
import { type BundlePolicy, bundlePolicyFor } from "../bundle/bundle.js";
import type { FileGrouper } from "../bundle/grouping.js";
import type {
  AgentRuntime,
  ModelChains,
  ReferenceIndex,
  SymbolExtractor,
  SyntaxChecker,
} from "../contracts.js";
import { GUIDELINE_SCOPES, type GuidelineScope } from "../docs/guidelines.js";
import type { ProjectDoc } from "../docs/project-docs.js";
import { OcraError } from "../errors.js";
import type { Learning } from "../knowledge/learning.js";
import type { MemoryEntry } from "../memory/memory.js";
import type { MergeCheck } from "../merge-checks/merge-check.js";
import type { InlinePolicy } from "../report/inline.js";
import type { ReviewEvent } from "../report/report.js";
import {
  isOptionalContext,
  OPTIONAL_CONTEXT,
  type OptionalContext,
} from "../review/context-sources.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { SourcedRule } from "../rules/repo-rules.js";
import type { SarifLog } from "../sarif/schema.js";
import type { SelectionPolicy } from "../select/select.js";
import type { TaskSource } from "../task/linked-task.js";
import type { VcsAdapter } from "../vcs.js";
import type { ProvenanceInput } from "./provenance.js";
import type { ResumedRun } from "./resume.js";

export interface ReviewOptions {
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  reviewers?: readonly ReviewerDefinition[];
  reviewerOverrides?: ReviewerOverrides;
  // Reasoning effort per model tier, and the roles' own (ADR-0025); a
  // reviewer's own is in reviewerOverrides.
  effort?: TierEfforts;
  roles?: RoleSettings;
  // The tier chains the runtime was given (RuntimeOptions.models), recorded
  // per agent in the provenance; a reviewer's or role's own chain is in
  // reviewerOverrides or roles and goes with its calls.
  models?: ModelChains;
  // Each with where it came from, when the caller knows, for the report.
  rules?: readonly SourcedRule[];
  // Where AGENTS.md and .ocra/rules.json are read from. Defaults to the
  // revision under review; pull request reviews pass the trusted base.
  readTrusted?: (path: string) => Promise<string | undefined>;
  // Findings the signed-in ocra Cloud account remembers for this repository
  // (ADR-0028), applied with .ocra/memory.json's; a fingerprint both list is
  // reported as the repository's.
  accountMemory?: readonly MemoryEntry[];
  // The team's learnings, which the caller reads from the same trusted
  // revision as the rules (ADR-0037); each task is given those that apply.
  learnings?: readonly Learning[];
  // Which sections of AGENTS.md each review task is given (ADR-0059):
  // "all" (the default), "matched" (those that apply to its files) or
  // "reviewer" (only the reviewers that check the guidelines).
  guidelineScope?: GuidelineScope;
  // Give the review tasks the tasks the platform links to the change
  // (ADR-0052); on unless false.
  linkedTasks?: boolean;
  // Trackers the platform does not link (Jira, TAPD), whose tasks the
  // change request names by key.
  taskSources?: readonly TaskSource[];
  // The team's design documents, read from the trusted revision; each task
  // is given the sections that name its files (ADR-0052).
  projectDocs?: readonly ProjectDoc[];
  // The team's pre-merge checks in plain words, each judged against the
  // change beside the review tasks (ADR-0054).
  mergeChecks?: readonly MergeCheck[];
  // Which files are reviewed; what is left out is defaultSelectionPolicy's.
  selection?: Partial<SelectionPolicy>;
  limits?: ReviewLimits;
  // Which findings a platform posts as inline comments; the rest are listed
  // in its summary, and every finding stays in the report (ADR-0076).
  inline?: InlinePolicy;
  stages?: ReviewStages;
  mode?: ReviewMode;
  identity?: RunIdentity;
  // An earlier run of this review: its completed tasks whose inputs have not
  // changed are reused, not run and paid for again (ADR-0031).
  resume?: ResumedRun;
  // Parses files for the impact analysis (review/impact.ts); absent:
  // definition patterns and whole-word search.
  symbols?: SymbolExtractor;
  // Resolves callers precisely where it knows the changed symbol, ahead of
  // the extractor's name matching.
  references?: ReferenceIndex;
  // Checks that a proposed fix leaves its file parsing; without it no fix
  // is proposed (ADR-0058).
  syntax?: SyntaxChecker;
  // SARIF logs of external analyzers; their results on the change join the
  // findings (pipeline/imports.ts).
  sarif?: readonly SarifLog[];
  // SARIF logs whose results on and near the change are shown to the
  // reviewers as evidence, not reported as findings (ADR-0042).
  sarifEvidence?: readonly SarifLog[];
  signal?: AbortSignal;
  onEvent?: (event: ReviewEvent) => void;
}

// What a run may spend: time, money, parallel tasks and review tasks.
export interface ReviewLimits {
  concurrency?: number;
  taskTimeoutMs?: number;
  runTimeoutMs?: number;
  // Review tasks stop starting at REVIEW_SHARE of this; Verify and
  // Judge use the rest, and are skipped (findings left unchecked) once it is
  // gone. Calls already running finish, so a run can end slightly above it.
  maxCostUsd?: number;
  // At most this many review tasks (DEFAULT_MAX_TASKS); the rest are skipped
  // and their files reported as not reviewed.
  maxTasks?: number;
  // The smallest context window, in tokens, of the models the run may call:
  // a task's diff is held to a share of it (ADR-0071). Unset, bundles are
  // sized for the large windows of current hosted models.
  contextWindow?: number;
}

// The stages after the review tasks: checking is on by default, the rest off.
export interface ReviewStages {
  // Fact-check findings before reporting them.
  verify?: boolean;
  // Merge, filter and recalibrate findings across reviewers on the top tier.
  judge?: boolean;
  // Report findings Verify traced to code from before the change (true by
  // default). They never count towards the verdict either way.
  showPreExisting?: boolean;
  // Write the walkthrough of the change for its reviewers (ADR-0047). Off
  // unless asked: the CLI asks for it on pull and merge requests.
  walkthrough?: boolean;
  // Propose a fix for findings where a local edit of their lines is one,
  // each checked before it is kept (ADR-0058). Off unless asked.
  fixes?: boolean;
}

export interface ReviewMode {
  // Review every file even when the platform reports what changed since the
  // previous review.
  full?: boolean;
  // Recall over cost: every reviewer at every tier, two samples per cell, and
  // findings the judge would drop kept as low confidence.
  ultra?: boolean;
  // Context left out of every review prompt, to measure what each source is
  // worth against a run with it (ADR-0057).
  without?: readonly OptionalContext[];
}

// How the run is named and what it records it was made with.
export interface RunIdentity {
  // Names the run in every output; the CLI passes its session id. Generated
  // when absent.
  runId?: string;
  // Recorded in the report with the prompt hash and the sampling applied.
  provenance?: ProvenanceInput;
}

// Tuning and test hooks, outside the contract: review() does not take them,
// reviewWithHooks(), which core's tests call, does.
export interface ReviewHooks {
  bundling?: BundlePolicy;
  grouper?: FileGrouper;
  // Replaces the runtime's light-model relocation (tests); `false` turns
  // relocation off.
  relocate?: AnchorContext["relocate"] | false;
  // How long a cut-off task may still deliver its usage and findings.
  abortGraceMs?: number;
}

export const REVIEW_DEFAULTS = {
  concurrency: 8,
  taskTimeoutMs: 10 * 60_000,
  runTimeoutMs: 25 * 60_000,
} as const;

// Timers fire at once past 2^31 - 1 ms (about 24.8 days); a longer timeout
// means no practical limit, so it is cut to the longest one a timer keeps.
export const MAX_TIMER_MS = 2 ** 31 - 1;

// Infinity is allowed (no practical limit), NaN never: z.number() refuses both.
const atLeast = (min: number, exclusive: boolean, what: string) =>
  z.custom<number>(
    (v) => typeof v === "number" && (exclusive ? v > min : v >= min),
    `must be ${what}`,
  );
const timeoutMs = atLeast(0, true, "a positive number of milliseconds");

const limitsSchema = z.object({
  concurrency: z.int().positive().optional(),
  taskTimeoutMs: timeoutMs.optional(),
  runTimeoutMs: timeoutMs.optional(),
  maxCostUsd: atLeast(0, false, "a number of US dollars, 0 or more").optional(),
  maxTasks: z.int().nonnegative().optional(),
  contextWindow: z.int().positive().optional(),
});

// What the stages read of ReviewOptions' limits, mode and stages: checked
// once at the entry, with the defaults applied. The CLI checks its own
// configuration; an embedder's options are checked here, so NaN or a
// negative number never reaches a stage.
export interface RunSettings {
  concurrency: number;
  // Cut to MAX_TIMER_MS.
  taskTimeoutMs: number;
  runTimeoutMs: number;
  maxCostUsd?: number;
  maxTasks?: number;
  bundling: BundlePolicy;
  ultra: boolean;
  full: boolean;
  verify: boolean;
  judge: boolean;
  showPreExisting: boolean;
  walkthrough: boolean;
  without: ReadonlySet<OptionalContext>;
  fixes: boolean;
  guidelineScope: GuidelineScope;
}

export function runSettings(
  options: Pick<ReviewOptions, "limits" | "mode" | "stages" | "guidelineScope">,
): RunSettings {
  const guidelineScope = options.guidelineScope ?? "all";
  if (!(GUIDELINE_SCOPES as readonly string[]).includes(guidelineScope)) {
    throw new OcraError(
      "CONFIG_INVALID",
      `ReviewOptions.guidelineScope must be one of ${GUIDELINE_SCOPES.join(", ")}`,
    );
  }
  const parsed = limitsSchema.safeParse(options.limits ?? {});
  if (!parsed.success) {
    throw new OcraError(
      "CONFIG_INVALID",
      `ReviewOptions.limits is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  const limits = parsed.data;
  return {
    concurrency: limits.concurrency ?? REVIEW_DEFAULTS.concurrency,
    taskTimeoutMs: Math.min(limits.taskTimeoutMs ?? REVIEW_DEFAULTS.taskTimeoutMs, MAX_TIMER_MS),
    runTimeoutMs: Math.min(limits.runTimeoutMs ?? REVIEW_DEFAULTS.runTimeoutMs, MAX_TIMER_MS),
    ...(limits.maxCostUsd === undefined ? {} : { maxCostUsd: limits.maxCostUsd }),
    ...(limits.maxTasks === undefined ? {} : { maxTasks: limits.maxTasks }),
    bundling: bundlePolicyFor(limits.contextWindow),
    ultra: options.mode?.ultra === true,
    full: options.mode?.full === true,
    verify: options.stages?.verify !== false,
    judge: options.stages?.judge !== false,
    showPreExisting: options.stages?.showPreExisting !== false,
    walkthrough: options.stages?.walkthrough === true,
    without: withoutContext(options.mode?.without ?? []),
    fixes: options.stages?.fixes === true,
    guidelineScope,
  };
}

function withoutContext(names: readonly string[]): ReadonlySet<OptionalContext> {
  const unknown = names.filter((n) => !isOptionalContext(n));
  if (unknown.length > 0) {
    throw new OcraError(
      "CONFIG_INVALID",
      `ReviewOptions.mode.without names unknown context: ${unknown.join(", ")} (known: ${OPTIONAL_CONTEXT.join(", ")})`,
    );
  }
  return new Set(names as OptionalContext[]);
}

// A reviewer that needs the guidelines does not run when they are left out.
export function guidelinesShown(
  guidelines: string | undefined,
  settings: Pick<RunSettings, "without">,
): boolean {
  return Boolean(guidelines?.trim()) && !settings.without.has("guidelines");
}
