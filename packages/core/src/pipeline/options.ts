import { z } from "zod";
import type { ReviewerOverrides, RoleSettings, TierEfforts } from "../agent/settings.js";
import type { AnchorContext } from "../anchor/anchor.js";
import type { BundlePolicy } from "../bundle/bundle.js";
import type { FileGrouper } from "../bundle/grouping.js";
import type { AgentRuntime, ModelChains } from "../contracts.js";
import { OcraError } from "../errors.js";
import type { MemoryEntry } from "../memory/memory.js";
import type { ReviewEvent } from "../report/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { SourcedRule } from "../rules/repo-rules.js";
import type { SarifLog } from "../sarif/schema.js";
import type { SelectionPolicy } from "../select/select.js";
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
  // Which files are reviewed; what is left out is defaultSelectionPolicy's.
  selection?: Partial<SelectionPolicy>;
  limits?: ReviewLimits;
  stages?: ReviewStages;
  mode?: ReviewMode;
  identity?: RunIdentity;
  // An earlier run of this review: its completed tasks whose inputs have not
  // changed are reused, not run and paid for again (ADR-0031).
  resume?: ResumedRun;
  // SARIF logs of external analyzers; their results on the change join the
  // findings (pipeline/imports.ts).
  sarif?: readonly SarifLog[];
  signal?: AbortSignal;
  onEvent?: (event: ReviewEvent) => void;
}

// What a run may spend: time, money, parallel tasks and review tasks.
export interface ReviewLimits {
  concurrency?: number;
  taskTimeoutMs?: number;
  runTimeoutMs?: number;
  // Review tasks stop starting at REVIEW_BUDGET_SHARE of this; Verify and
  // Judge use the rest, and are skipped (findings left unchecked) once it is
  // gone. Calls already running finish, so a run can end slightly above it.
  maxCostUsd?: number;
  // At most this many review tasks (DEFAULT_MAX_TASKS); the rest are skipped
  // and their files reported as not reviewed.
  maxTasks?: number;
}

// The checking stages after the review tasks, both on by default.
export interface ReviewStages {
  // Fact-check findings before reporting them.
  verify?: boolean;
  // Merge, filter and recalibrate findings across reviewers on the top tier.
  judge?: boolean;
}

export interface ReviewMode {
  // Review every file even when the platform reports what changed since the
  // previous review.
  full?: boolean;
  // Recall over cost: every reviewer at every tier, two samples per cell, and
  // findings the judge would drop kept as low confidence.
  ultra?: boolean;
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
  concurrency: 4,
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
  ultra: boolean;
  full: boolean;
  verify: boolean;
  judge: boolean;
}

export function runSettings(
  options: Pick<ReviewOptions, "limits" | "mode" | "stages">,
): RunSettings {
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
    ultra: options.mode?.ultra === true,
    full: options.mode?.full === true,
    verify: options.stages?.verify !== false,
    judge: options.stages?.judge !== false,
  };
}
