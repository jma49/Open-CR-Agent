import { type OneShot, oneShot } from "../agent/model-call.js";
import { roleCall } from "../agent/settings.js";
import { spendLimit } from "../agent/spend-limit.js";
import type { AgentRuntime, SyntaxChecker, Usage } from "../contracts.js";
import { errorMessage } from "../errors.js";
import { mendScope } from "../mend/gate.js";
import type { MendLevel } from "../mend/outcomes.js";
import { type MendItemResult, type MendRound, nextState } from "../mend/round.js";
import type { MendState } from "../mend/state.js";
import type { ChangeConflicts, VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import { conflictRound } from "./mend-conflicts.js";
import type { ReviewOptions } from "./options.js";

interface MergeOptions extends Pick<ReviewOptions, "effort" | "roles"> {
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  syntax: SyntaxChecker;
  level: MendLevel;
  maxCostUsd?: number;
  protectedPaths?: readonly string[];
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

// What stands between the head and a merge of its base branch. An adapter
// that cannot tell, or a merge that cannot be read (a shallow clone, an old
// git), leaves the round to its other items, with a warning.
export async function changeConflicts(
  vcs: VcsAdapter,
  headSha: string,
  warnings: string[],
): Promise<ChangeConflicts | undefined> {
  if (!vcs.conflicts) {
    warnings.push(`the ${vcs.name} adapter reads no merge conflicts: none was worked on`);
    return undefined;
  }
  try {
    return await vcs.conflicts(headSha);
  } catch (error) {
    warnings.push(`reading the change's merge conflicts failed: ${errorMessage(error)}`);
    return undefined;
  }
}

// A round over the change's merge conflicts, and over nothing else: its
// commit is a merge of the base branch, so the round's other items wait for
// the next one (`waiting`, deferred). The merge is written only when every
// conflicted file is resolved and checked.
export async function mergeRound(
  options: MergeOptions,
  conflicts: ChangeConflicts,
  round: { headSha: string; before: MendState; warnings: string[]; waiting: MendItemResult[] },
): Promise<MendRound> {
  const { vcs } = options;
  const { headSha, before, warnings } = round;
  const diffs = await vcs.getDiff();
  const remaining =
    options.maxCostUsd === undefined ? undefined : options.maxCostUsd - before.costUsd;
  const limit = spendLimit(remaining);
  let spent = 0;
  const ask = oneShot(options.runtime, (usage) => {
    limit.charge(usage);
    spent += usage.costUsd;
    options.onUsage(usage);
  }) as OneShot;
  const answered = await conflictRound(conflicts, before, {
    ask,
    context: reviewContext(vcs, diffs),
    scope: mendScope(diffs, options.protectedPaths),
    syntax: options.syntax,
    spendLimit: limit,
    fixer: roleCall("fixer", options),
    verifier: roleCall("verifier", options),
    signal: options.signal,
    onWarning: (w) => warnings.push(w),
  });
  const ended = (
    outcome: MendRound["outcome"],
    items: MendItemResult[],
    more: Partial<MendRound> = {},
  ): MendRound => ({
    headSha,
    outcome,
    mergeParent: conflicts.mergeParent,
    items: [...items, ...round.waiting],
    state: nextState(before, items, spent),
    warnings,
    ...more,
  });
  const { resolved } = answered;
  if (!resolved) return ended("nothing", answered.items);
  if (options.level === "propose") {
    const files = new Map(resolved.map((file) => [file.path, file]));
    return ended(
      "proposed",
      answered.items.map((item) => {
        const file = files.get(item.conflict);
        return {
          ...item,
          outcome: "proposed",
          resolved: file?.content as string,
          regions: file?.regions ?? [],
        };
      }),
    );
  }
  if (!vcs.commit) return ended("not_writable", deferred(answered.items, "not_writable"));
  const result = await vcs.commit({
    parent: headSha,
    mergeParent: conflicts.mergeParent,
    message: mergeMessage(conflicts.mergeParent, resolved),
    files: resolved.map(({ path, content, executable }) => ({
      path,
      content,
      executable,
      created: false,
    })),
  });
  if (!result.committed) return ended(result.outcome, deferred(answered.items, result.outcome));
  await vcs
    .note?.({
      commitSha: result.sha,
      merge: true,
      fixed: answered.items.map((item) => ({ title: "merge conflict", file: item.conflict })),
      left: [],
    })
    .catch((error) => warnings.push(`the round's note was not posted: ${errorMessage(error)}`));
  return ended("committed", answered.items, { sha: result.sha });
}

function deferred(
  items: readonly MendItemResult[],
  reason: "head_moved" | "not_writable",
): MendItemResult[] {
  return items.map(({ id, conflict }) => ({
    id,
    ...(conflict ? { conflict } : {}),
    outcome: "deferred",
    reason,
  }));
}

// Paths come from the change: one line each, behind a list marker, so none
// can add a trailer or a line of its own.
function mergeMessage(mergeParent: string, files: readonly { path: string }[]): string {
  const clean = (text: string) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029\s]+/gu, " ").trim();
  return [
    `Merge ${mergeParent.slice(0, 12)} of the base branch, conflicts resolved by ocra`,
    "",
    ...files.map((file) => `- ${clean(file.path)}`),
    "",
    "ocra ran nothing from the repository to check this merge: the change request's own checks do.",
  ].join("\n");
}
