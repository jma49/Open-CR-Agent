import type { CallFailure } from "../errors.js";
import type { ResolvedRegion } from "./conflict.js";
import type { ItemOutcome, ItemReason, MEND_OUTCOMES } from "./outcomes.js";
import type { Hunk } from "./patch.js";
import { closedAs, type ItemState, type MendState, type RoundStop } from "./state.js";

export interface MendItemResult {
  id: string;
  // The failed check's name, for an item that is one.
  check?: string;
  // The conflicted file's path, for an item that is one.
  conflict?: string;
  outcome: ItemOutcome;
  reason?: ItemReason;
  // What failed, for the reason `failed`.
  cause?: CallFailure;
  // What the round wrote for it, against the head: set for fixed and proposed.
  edits?: readonly Hunk[];
  // A conflicted file's whole content with its conflicts answered: set for a
  // proposed one.
  resolved?: string;
  // That file's answered regions, each with both sides: set with `resolved`.
  regions?: readonly ResolvedRegion[];
}

export interface MendRound {
  headSha: string;
  outcome: (typeof MEND_OUTCOMES)[number];
  // Why no round ran, for `stopped`.
  stopped?: RoundStop;
  // The commit written, for `committed`.
  sha?: string;
  // The base branch's commit a conflict round merged, or proposes to merge.
  mergeParent?: string;
  items: MendItemResult[];
  // What to pass to the next round.
  state: MendState;
  warnings: string[];
}

// A deferred item was not tried, or its patch was not written: its attempt
// is not counted, so a person's push or a full round costs it nothing.
export function nextState(
  before: MendState,
  results: Iterable<Pick<MendItemResult, "id" | "outcome">>,
  spent: number,
): MendState {
  const items: Record<string, ItemState> = { ...before.items };
  for (const { id, outcome } of results) {
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
