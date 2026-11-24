import { type OneShot, oneShot } from "../agent/model-call.js";
import { mapWithConcurrency } from "../agent/pool.js";
import { roleCall } from "../agent/settings.js";
import { spendLimit } from "../agent/spend-limit.js";
import type { AgentRuntime, SyntaxChecker, Usage } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import { type CallFailure, errorMessage, OcraError } from "../errors.js";
import { headMode } from "../generate/targets.js";
import { CHECK_LIMITS, checkItemId } from "../mend/checks.js";
import { mendScope } from "../mend/gate.js";
import type { ItemOutcome, ItemReason, MEND_OUTCOMES, MendLevel } from "../mend/outcomes.js";
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
import { type VerificationStep, verifierStep } from "../mend/verify.js";
import { oneLine } from "../review/prompt-text.js";
import type { ChangeChecks, ChangeCommit, RoundNote, RoundNoteItem, VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import type { StoredFinding } from "./fix-finding.js";
import { type Attempt, attempt, type Head, type WorkItem } from "./mend-attempt.js";
import type { ReviewOptions } from "./options.js";

export {
  MEND_ITEM_OUTCOMES,
  MEND_ITEM_REASONS,
  MEND_LEVELS,
  MEND_OUTCOMES,
  type MendLevel,
} from "../mend/outcomes.js";

const CONCURRENCY = 3;
const SUBJECT_TITLE_CHARS = 100;

interface MendItemResult {
  id: string;
  // The failed check's name, for an item that is one; a finding has none.
  check?: string;
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
  // Also work on the checks that failed on the head.
  checks?: boolean;
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

// One round of the fix loop (ADR-0078) over accepted findings and, when
// asked, the checks that failed on the head: each open item gets a patch
// from its lane, the gate and the verifier decide what is kept, and the kept
// patches become one commit from the head they were made at. Nothing from
// the change runs.
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

  const checks = options.checks ? await failedChecks(vcs, headSha, warnings) : undefined;
  const items: WorkItem[] = [
    ...unique(options.findings).map((finding) => ({ id: finding.fingerprint, finding })),
    ...(checks?.failed ?? []).map((check) => ({ id: checkItemId(check), check })),
  ];
  const named = (item: WorkItem) => ("check" in item ? { check: item.check.name } : {});
  const results = new Map<string, MendItemResult>();
  const open: WorkItem[] = [];
  for (const item of items) {
    const { id } = item;
    const closed = closedAs(before.items[id]);
    if (closed) {
      const used = before.items[id]?.closed === undefined;
      results.set(id, { id, outcome: closed, ...(used ? { reason: "attempts" as const } : {}) });
    } else if (open.length < MEND_LIMITS.itemsPerRound) open.push(item);
    else results.set(id, { id, outcome: "deferred", reason: "no_room" });
  }
  const listed = () =>
    items.map((item) => ({ ...(results.get(item.id) as MendItemResult), ...named(item) }));
  if (open.length === 0) {
    return ended({ outcome: checks?.pending ? "waiting" : "nothing", items: listed() });
  }

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
  const attempts = await mapWithConcurrency(open, CONCURRENCY, async (item) => {
    if (!limit.mayCall()) return { outcome: "deferred", reason: "no_room" } satisfies Attempt;
    return attempt(item, head, steps, {
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
  open.forEach(({ id }, i) => {
    const tried = attempts[i] as Attempt;
    if ("patch" in tried) patches.push(tried.patch);
    else results.set(id, { id, ...tried });
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
        : await commit(
            vcs,
            headSha,
            composed.changes,
            items.filter((item) => composed.kept.includes(item.id)),
            diffs,
          );
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
  if (round.outcome === "committed" && round.sha) {
    await vcs
      .note?.(roundNote(round.sha, items, results))
      .catch((error) => warnings.push(`the round's note was not posted: ${errorMessage(error)}`));
  }
  return ended({ ...round, items: listed(), state: nextState(before, results, spent) });
}

function roundNote(
  commitSha: string,
  items: readonly WorkItem[],
  results: ReadonlyMap<string, MendItemResult>,
): RoundNote {
  const note: RoundNote = { commitSha, fixed: [], left: [] };
  for (const item of items) {
    const named: RoundNoteItem =
      "check" in item
        ? { title: item.check.name, check: true }
        : { title: item.finding.title, file: item.finding.file };
    const result = results.get(item.id);
    if (result?.outcome === "fixed") note.fixed.push(named);
    else if (result) {
      note.left.push({
        ...named,
        outcome: result.outcome,
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
  }
  return note;
}

async function commit(
  vcs: VcsAdapter,
  parent: string,
  changes: readonly FileChange[],
  fixed: readonly WorkItem[],
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

// Titles, paths and check names come from the change and its platform: one
// line each, cut, and behind a list marker, so none can add a trailer or a
// line of its own.
function commitMessage(fixed: readonly WorkItem[]): string {
  const clean = (text: string) => oneLine(text).replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ");
  const title = (text: string) => clean(text).slice(0, SUBJECT_TITLE_CHARS);
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const checks = fixed.filter((item) => "check" in item).length;
  const findings = fixed.length - checks;
  const what = [
    ...(findings > 0 ? [count(findings, "finding")] : []),
    ...(checks > 0 ? [count(checks, "failed check")] : []),
  ].join(" and ");
  return [
    `fix: apply ocra's fixes for ${what}`,
    "",
    ...fixed.map((item) =>
      "check" in item
        ? `- check: ${title(item.check.name)}`
        : `- ${clean(item.finding.file)}: ${title(item.finding.title)}`,
    ),
    "",
    "ocra ran nothing from the repository to check these edits: the change request's own checks do.",
  ].join("\n");
}

// What failed on the head, at most the checks a round reads. A platform that
// cannot be asked leaves the round to its findings, with a warning.
async function failedChecks(
  vcs: VcsAdapter,
  headSha: string,
  warnings: string[],
): Promise<ChangeChecks | undefined> {
  if (!vcs.checks) {
    warnings.push(`the ${vcs.name} adapter reads no checks: none was worked on`);
    return undefined;
  }
  try {
    const checks = await vcs.checks(headSha);
    return { ...checks, failed: checks.failed.slice(0, CHECK_LIMITS.checks) };
  } catch (error) {
    warnings.push(`reading the change's checks failed: ${errorMessage(error)}`);
    return undefined;
  }
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
