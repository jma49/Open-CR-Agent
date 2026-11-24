import type { OneShot } from "../agent/model-call.js";
import { mapWithConcurrency } from "../agent/pool.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { SpendLimit } from "../agent/spend-limit.js";
import type { ReviewContext, SyntaxChecker } from "../contracts.js";
import { type CallFailure, callFailure, errorMessage } from "../errors.js";
import { shortHash } from "../hash.js";
import {
  buildConflictCheckPrompt,
  buildConflictPrompt,
  CONFLICT_LIMITS,
  type ConflictSegment,
  conflictVerdict,
  parseConflicts,
  type ResolvedRegion,
  resolveConflicts,
  tooLargeToResolve,
} from "../mend/conflict.js";
import type { MendScope } from "../mend/gate.js";
import type { ItemOutcome, ItemReason } from "../mend/outcomes.js";
import { closedAs, type MendState } from "../mend/state.js";
import { isUnsafeCodePoint } from "../unsafe-text.js";
import type { ChangeConflicts, ConflictedFile } from "../vcs.js";

const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 180_000;

interface ConflictResult {
  id: string;
  // The conflicted file's path.
  conflict: string;
  outcome: ItemOutcome;
  reason?: ItemReason;
  cause?: CallFailure;
}

export interface ConflictRound {
  items: ConflictResult[];
  // Every conflicted file with its conflicts answered and checked; absent
  // unless all of them are, since a merge is committed whole or not at all.
  resolved?: { path: string; content: string; executable: boolean; regions: ResolvedRegion[] }[];
}

interface ConflictDeps {
  ask: OneShot;
  context: ReviewContext;
  scope: MendScope;
  syntax: SyntaxChecker;
  spendLimit: Pick<SpendLimit, "mayCall">;
  fixer: AgentCallSettings | undefined;
  verifier: AgentCallSettings | undefined;
  signal: AbortSignal;
  onWarning: (warning: string) => void;
}

type Refusal = Pick<ConflictResult, "outcome" | "reason" | "cause">;
type Resolved = { content: string; regions: ResolvedRegion[] };

// A conflicted file as the loop's work item: the same item, with the same
// attempts, while git merges it to the same text (ADR-0078 point 8).
export function conflictItemId(file: { path: string; merged?: string }): string {
  return shortHash(`conflict\0${file.path}\0${shortHash(file.merged ?? "")}`);
}

// A round over the conflicts of merging the base branch into the head: one
// call on the fixer role per conflicted file answers its regions, code puts
// the file together, and one call on the verifier role checks it. Files the
// lane cannot take stop the round before any call.
export async function conflictRound(
  conflicts: ChangeConflicts,
  before: MendState,
  deps: ConflictDeps,
): Promise<ConflictRound> {
  const person = (reason: ItemReason): Refusal => ({ outcome: "needs_human", reason });
  const items: ConflictResult[] = conflicts.other.map((path) => ({
    id: conflictItemId({ path }),
    conflict: path,
    ...person("not_candidate"),
  }));
  const open: { id: string; file: ConflictedFile; segments: ConflictSegment[] }[] = [];
  for (const [index, file] of conflicts.files.entries()) {
    const id = conflictItemId(file);
    const segments = parseConflicts(file.merged, file.markerSize);
    const closed = closedAs(before.items[id]);
    const scoped = deps.scope.refusal(file.path);
    const refused: Refusal | undefined = closed
      ? { outcome: closed, reason: "attempts" }
      : scoped
        ? person(scoped)
        : !segments
          ? person("not_candidate")
          : index >= CONFLICT_LIMITS.files || tooLargeToResolve(segments)
            ? person("too_large")
            : undefined;
    if (refused) items.push({ id, conflict: file.path, ...refused });
    else if (segments) open.push({ id, file, segments });
  }
  const waiting = (): ConflictResult[] =>
    open.map(({ id, file }) => ({
      id,
      conflict: file.path,
      outcome: "deferred",
      reason: "conflicts",
    }));
  if (items.length > 0 || open.length === 0) return { items: [...items, ...waiting()] };

  const answers = await mapWithConcurrency(open, CONCURRENCY, async ({ file, segments }) =>
    deps.spendLimit.mayCall()
      ? resolveFile(file, segments, deps)
      : ({ outcome: "deferred", reason: "no_room" } satisfies Refusal),
  );
  const results = open.map(({ id, file }, i): ConflictResult => {
    const answer = answers[i] as Refusal | Resolved;
    return "content" in answer
      ? { id, conflict: file.path, outcome: "deferred", reason: "conflicts" }
      : { id, conflict: file.path, ...answer };
  });
  if (answers.some((answer) => !("content" in answer))) return { items: results };
  return {
    items: open.map(({ id, file }) => ({ id, conflict: file.path, outcome: "fixed" })),
    resolved: open.map(({ file }, i) => ({
      path: file.path,
      ...(answers[i] as Resolved),
      executable: file.executable,
    })),
  };
}

async function resolveFile(
  file: ConflictedFile,
  segments: readonly ConflictSegment[],
  deps: ConflictDeps,
): Promise<Refusal | Resolved> {
  const rejected = (reason: ItemReason, cause?: CallFailure): Refusal => ({
    outcome: "rejected",
    reason,
    ...(cause ? { cause } : {}),
  });
  const call = async (agent: "fixer" | "verifier", prompt: { system: string; user: string }) =>
    deps.ask(
      {
        tier: "standard",
        agent,
        call: agent === "fixer" ? deps.fixer : deps.verifier,
        ...prompt,
        timeoutMs: CALL_TIMEOUT_MS,
      },
      deps.signal,
    );
  try {
    const answer = resolveConflicts(
      segments,
      await call("fixer", buildConflictPrompt(file.path, segments)),
    );
    if ("refused" in answer) {
      return answer.refused === "declined"
        ? rejected("declined")
        : rejected("failed", "invalid_output");
    }
    for (const char of answer.file) {
      if (isUnsafeCodePoint(char.codePointAt(0) as number)) return rejected("unsafe");
    }
    // The file parsed on the change request's side: the merge may not break it.
    const ours = await deps.context.readFile(file.path);
    const [was, now] = await Promise.all([
      ours === undefined ? undefined : deps.syntax.errors(file.path, ours),
      deps.syntax.errors(file.path, answer.file),
    ]);
    if (was !== undefined && now !== undefined && now > was) return rejected("syntax");
    if (!deps.spendLimit.mayCall()) return { outcome: "deferred", reason: "no_room" };
    const verdict = conflictVerdict(
      await call("verifier", buildConflictCheckPrompt(file.path, segments, answer.resolutions)),
    );
    if (verdict === "resolves") return { content: answer.file, regions: answer.regions };
    return rejected(
      verdict === "does_not_resolve" ? "unresolved" : verdict === "unsure" ? "unsure" : "unchecked",
    );
  } catch (error) {
    if (deps.signal.aborted) throw error;
    deps.onWarning(`resolving the conflicts of ${file.path} failed: ${errorMessage(error)}`);
    return rejected("failed", callFailure(error));
  }
}
