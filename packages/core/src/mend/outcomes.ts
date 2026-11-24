import { FIX_REJECTIONS } from "../fix/check.js";
import { GATE_REJECTIONS } from "./gate.js";
import { VERIFICATION_REJECTIONS } from "./verify.js";

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
export type ItemOutcome = (typeof MEND_ITEM_OUTCOMES)[number];

export const MEND_ITEM_REASONS = [
  ...new Set([
    ...FIX_REJECTIONS,
    "not_candidate",
    ...GATE_REJECTIONS,
    ...VERIFICATION_REJECTIONS,
    "overlap",
    "no_room",
    "attempts",
    "conflicts",
    "head_moved",
    "not_writable",
  ] as const),
];
export type ItemReason = (typeof MEND_ITEM_REASONS)[number];

// waiting: the head's checks have not finished and nothing else is open, so
// the round did nothing and counts as none.
export const MEND_OUTCOMES = [
  "committed",
  "proposed",
  "nothing",
  "stopped",
  "head_moved",
  "not_writable",
  "waiting",
] as const;
