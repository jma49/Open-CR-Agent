import { type OneShot, oneShot } from "../agent/model-call.js";
import { mapWithConcurrency } from "../agent/pool.js";
import { roleCall } from "../agent/settings.js";
import { spendLimit } from "../agent/spend-limit.js";
import type { AgentRuntime, ReviewContext, SyntaxChecker, Usage } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import { type CallFailure, OcraError } from "../errors.js";
import { FIX_REJECTIONS } from "../fix/check.js";
import { headMode } from "../generate/targets.js";
import { GATE_REJECTIONS, gate, type MendScope, mendScope } from "../mend/gate.js";
import { composePatches, type FileChange, type Hunk, type ItemPatch } from "../mend/patch.js";
import {
  closedAs,
  EMPTY_STATE,
  type ItemState,
  MEND_LIMITS,
  type MendState,
  type RoundStop,
  roundStop,
} from "../mend/state.js";
import { VERIFICATION_REJECTIONS, type VerificationStep, verifierStep } from "../mend/verify.js";
import { oneLine } from "../review/prompt-text.js";
import type { ChangeCommit, VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import { fixAtHead, type StoredFinding } from "./fix-finding.js";
import { agentPatch } from "./mend-agent.js";
import type { ReviewOptions } from "./options.js";

const CONCURRENCY = 3;
const SUBJECT_TITLE_CHARS = 100;

// `propose` ends a round with its checked changes for a person to commit;
// `commit` writes them to the change request's branch.
export const MEND_LEVELS = ["propose", "commit"] as const;
export type MendLevel = (typeof MEND_LEVELS)[number];

// fixed, proposed: its patch is in the round's commit, or in what the round
// proposes. rejected: this round wrote no patch that passed; another may.
// deferred: not tried, or tried and not written; no attempt is counted.
// needs_human, gone: closed, for a person or because its code is gone.
export const MEND_ITEM_OUTCOMES = [
  "fixed",
  "proposed",
  "rejected",
  "deferred",
  "needs_human",
  "gone",
] as const;
type ItemOutcome = (typeof MEND_ITEM_OUTCOMES)[number];

export const MEND_ITEM_REASONS = [
  ...new Set([
    ...FIX_REJECTIONS,
    "not_candidate",
    ...GATE_REJECTIONS,
    ...VERIFICATION_REJECTIONS,
    "overlap",
    "no_room",
    "attempts",
    "head_moved",
    "not_writable",
  ] as const),
];
type ItemReason = (typeof MEND_ITEM_REASONS)[number];

export const MEND_OUTCOMES = [
  "committed",
  "proposed",
  "nothing",
  "stopped",
  "head_moved",
  "not_writable",
] as const;

interface MendItemResult {
  id: string;
  outcome: ItemOutcome;
  reason?: ItemReason;
  // What failed, for the reason `failed`.
  cause?: CallFailure;
  // What the round wrote for it, against the head: set for fixed and proposed.
  edits?: readonly Hunk[];
}

export interface MendRound {
  headSha: string;
  outcome: (typeof MEND_OUTCOMES)[number];
  // Why no round ran, for `stopped`.
  stopped?: RoundStop;
  // The commit written, for `committed`.
  sha?: string;
  items: MendItemResult[];
  // What to pass to the next round.
  state: MendState;
  warnings: string[];
}

interface MendOptions extends Pick<ReviewOptions, "effort" | "roles"> {
  // The findings a person accepted, the most important first.
  findings: readonly StoredFinding[];
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  syntax: SyntaxChecker;
  level: MendLevel;
  state?: MendState;
  // The head the caller saw; another one answers head_moved.
  expectedHead?: string;
  // For the change request's rounds together, the state's spend included.
  maxCostUsd?: number;
  protectedPaths?: readonly string[];
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

interface Head {
  diffs: readonly FileDiff[];
  context: ReviewContext;
  scope: MendScope;
  contents: Map<string, string>;
}

type Attempt =
  | { patch: ItemPatch }
  | { outcome: ItemOutcome; reason: ItemReason; cause?: CallFailure };

// A person decides these: no later round at this head answers differently.
const FOR_A_PERSON: ReadonlySet<ItemReason> = new Set<ItemReason>([
  "not_candidate",
  "no_parser",
  "out_of_scope",
  "protected",
  "too_large",
  "tamper",
]);

// Why the local lane wrote nothing for a finding an edit may still fix: it
// spans more than the lane takes, or needs lines elsewhere.
const NOT_LOCAL: ReadonlySet<ItemReason> = new Set<ItemReason>([
  "not_candidate",
  "declined",
  "too_large",
]);

// One round of the fix loop (ADR-0078) over accepted findings: each open
// finding gets a patch from its lane, the gate and the verifier decide what
// is kept, and the kept patches become one commit from the head they were
// made at. Nothing from the change runs.
export async function mendRound(options: MendOptions): Promise<MendRound> {
  const { vcs } = options;
  const before = options.state ?? EMPTY_STATE;
  const warnings: string[] = [];
  if (!oneShot(options.runtime, () => {})) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `the ${options.runtime.name} runtime makes no plain completions, which ocra mend needs`,
    );
  }
  const { headSha } = await vcs.getChangeRequest();
  const ended = (round: Partial<MendRound> & Pick<MendRound, "outcome">): MendRound => ({
    headSha,
    items: [],
    state: before,
    warnings,
    ...round,
  });
  if (options.expectedHead !== undefined && options.expectedHead !== headSha) {
    return ended({ outcome: "head_moved" });
  }
  if (options.level === "commit" && !vcs.commit) return ended({ outcome: "not_writable" });
  const stopped = roundStop(before, options.maxCostUsd);
  if (stopped) return ended({ outcome: "stopped", stopped });

  const findings = unique(options.findings);
  const results = new Map<string, MendItemResult>();
  const open: StoredFinding[] = [];
  for (const finding of findings) {
    const id = finding.fingerprint;
    const closed = closedAs(before.items[id]);
    if (closed) {
      const used = before.items[id]?.closed === undefined;
      results.set(id, { id, outcome: closed, ...(used ? { reason: "attempts" as const } : {}) });
    } else if (open.length < MEND_LIMITS.itemsPerRound) open.push(finding);
    else results.set(id, { id, outcome: "deferred", reason: "no_room" });
  }
  const listed = () => findings.map((f) => results.get(f.fingerprint) as MendItemResult);
  if (open.length === 0) return ended({ outcome: "nothing", items: listed() });

  const diffs = await vcs.getDiff();
  const head: Head = {
    diffs,
    context: reviewContext(vcs, diffs),
    scope: mendScope(diffs, options.protectedPaths),
    contents: new Map(),
  };
  const remaining =
    options.maxCostUsd === undefined ? undefined : options.maxCostUsd - before.costUsd;
  const limit = spendLimit(remaining);
  let spent = 0;
  const onUsage = (usage: Usage) => {
    spent += usage.costUsd;
    options.onUsage(usage);
  };
  // The fixer's calls are charged to the limit where they are made.
  const ask = oneShot(options.runtime, (usage) => {
    limit.charge(usage);
    onUsage(usage);
  }) as OneShot;
  const steps: VerificationStep[] = [
    verifierStep(ask, roleCall("verifier", options), (w) => warnings.push(w)),
  ];
  const attempts = await mapWithConcurrency(open, CONCURRENCY, async (finding) => {
    if (!limit.mayCall()) return { outcome: "deferred", reason: "no_room" } satisfies Attempt;
    return attempt(finding, head, steps, {
      runtime: options.runtime,
      syntax: options.syntax,
      spendLimit: limit,
      call: roleCall("fixer", options),
      signal: options.signal,
      onUsage,
      onWarning: (w) => warnings.push(w),
    });
  });

  const patches: ItemPatch[] = [];
  open.forEach((finding, i) => {
    const tried = attempts[i] as Attempt;
    if ("patch" in tried) patches.push(tried.patch);
    else results.set(finding.fingerprint, { id: finding.fingerprint, ...tried });
  });
  const composed = composePatches(patches, head.contents, MEND_LIMITS);
  for (const { item, reason } of composed.left) {
    results.set(item, { id: item, outcome: "deferred", reason });
  }

  let round: Pick<MendRound, "outcome" | "sha"> = { outcome: "nothing" };
  if (composed.changes.length > 0) {
    round =
      options.level === "propose"
        ? { outcome: "proposed" }
        : await commit(vcs, headSha, composed.changes, kept(findings, composed.kept), diffs);
  }
  for (const patch of patches.filter((p) => composed.kept.includes(p.item))) {
    const id = patch.item;
    results.set(
      id,
      round.outcome === "committed"
        ? { id, outcome: "fixed", edits: patch.hunks }
        : round.outcome === "proposed"
          ? { id, outcome: "proposed", edits: patch.hunks }
          : { id, outcome: "deferred", reason: round.outcome as "head_moved" | "not_writable" },
    );
  }
  return ended({ ...round, items: listed(), state: nextState(before, results, spent) });
}

interface AttemptDeps extends Omit<Parameters<typeof fixAtHead>[1], "diffs" | "context"> {
  onWarning: (warning: string) => void;
}

// One finding through its lane, the gate and the verification steps.
async function attempt(
  finding: StoredFinding,
  head: Head,
  steps: readonly VerificationStep[],
  deps: AttemptDeps,
): Promise<Attempt> {
  const refuse = (reason: ItemReason, cause?: CallFailure): Attempt => ({
    outcome: reason === "stale" ? "gone" : FOR_A_PERSON.has(reason) ? "needs_human" : "rejected",
    reason,
    ...(cause ? { cause } : {}),
  });
  const outside = head.scope.refusal(finding.file);
  if (outside) return refuse(outside);
  const written = await write(finding, head, deps);
  if (!("patch" in written)) {
    return written.reason === "no_room"
      ? { outcome: "deferred", reason: "no_room" }
      : refuse(written.reason, written.cause);
  }
  const { patch } = written;
  const gated = await gate(patch, head.contents, head.scope, deps.syntax, MEND_LIMITS);
  if (gated) return refuse(gated);
  for (const step of steps) {
    if (!deps.spendLimit.mayCall()) return { outcome: "deferred", reason: "no_room" };
    const refused = await step(
      { title: finding.title, body: finding.body, patch, heads: head.contents },
      deps.signal,
    );
    if (refused) return refuse(refused);
  }
  return { patch };
}

// The patch for one finding, by the smallest lane that can write it: the fix
// stage's completion for a local edit, else a task with the edit tool, where
// the runtime runs one.
async function write(
  finding: StoredFinding,
  head: Head,
  deps: AttemptDeps,
): Promise<{ patch: ItemPatch } | { reason: ItemReason; cause?: CallFailure }> {
  const fixed = await fixAtHead(finding, { ...deps, diffs: head.diffs, context: head.context });
  for (const warning of fixed.warnings) deps.onWarning(warning);
  if ("fix" in fixed) {
    const content = await head.context.readFile(finding.file);
    if (content === undefined) return { reason: "stale" };
    head.contents.set(finding.file, content);
    return {
      patch: { item: finding.fingerprint, hunks: [{ path: finding.file, ...fixed.fix }] },
    };
  }
  if (!deps.runtime.toolsets || !NOT_LOCAL.has(fixed.reason)) return fixed;
  const edited = await agentPatch(
    {
      id: finding.fingerprint,
      file: finding.file,
      title: finding.title,
      body: finding.body,
      code: finding.existingCode,
      suggestion: finding.suggestion,
    },
    { ...deps, context: head.context, scope: head.scope },
  );
  if (!("patch" in edited)) {
    if (edited.warning) deps.onWarning(edited.warning);
    return edited;
  }
  for (const [path, content] of edited.heads) head.contents.set(path, content);
  return edited;
}

async function commit(
  vcs: VcsAdapter,
  parent: string,
  changes: readonly FileChange[],
  fixed: readonly StoredFinding[],
  diffs: readonly FileDiff[],
): Promise<Pick<MendRound, "outcome" | "sha">> {
  if (!vcs.commit) return { outcome: "not_writable" };
  const change: ChangeCommit = {
    parent,
    message: commitMessage(fixed),
    files: changes.map(({ path, after }) => ({
      path,
      content: after,
      created: false,
      executable: executable(path, diffs),
    })),
  };
  const result = await vcs.commit(change);
  return result.committed ? { outcome: "committed", sha: result.sha } : { outcome: result.outcome };
}

function executable(path: string, diffs: readonly FileDiff[]): boolean {
  const diff = diffs.find((d) => d.newPath === path);
  return diff !== undefined && headMode(diff) === "100755";
}

// Titles and paths come from a review of the change: one line each, cut, and
// behind a list marker, so none can add a trailer or a line of its own.
function commitMessage(fixed: readonly StoredFinding[]): string {
  const clean = (text: string) => oneLine(text).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ");
  return [
    `fix: apply ocra's fixes for ${fixed.length} finding${fixed.length === 1 ? "" : "s"}`,
    "",
    ...fixed.map((f) => `- ${clean(f.file)}: ${clean(f.title).slice(0, SUBJECT_TITLE_CHARS)}`),
    "",
    "ocra ran nothing from the repository to check these edits: the change request's own checks do.",
  ].join("\n");
}

function kept(findings: readonly StoredFinding[], ids: readonly string[]): StoredFinding[] {
  return findings.filter((f) => ids.includes(f.fingerprint));
}

function unique(findings: readonly StoredFinding[]): StoredFinding[] {
  const seen = new Set<string>();
  return findings.filter((f) => !seen.has(f.fingerprint) && seen.add(f.fingerprint));
}

// A deferred item was not tried, or its patch was not written: its attempt
// is not counted, so a person's push or a full round costs it nothing.
function nextState(
  before: MendState,
  results: ReadonlyMap<string, MendItemResult>,
  spent: number,
): MendState {
  const items: Record<string, ItemState> = { ...before.items };
  for (const { id, outcome } of results.values()) {
    const was = items[id] ?? { attempts: 0 };
    if (outcome === "deferred" || was.closed) continue;
    const used = closedAs(was);
    if (used) items[id] = { ...was, closed: used };
    else if (outcome === "needs_human" || outcome === "gone") {
      items[id] = { attempts: was.attempts + 1, closed: outcome };
    } else items[id] = { attempts: was.attempts + 1 };
  }
  return { rounds: before.rounds + 1, costUsd: before.costUsd + spent, items };
}
