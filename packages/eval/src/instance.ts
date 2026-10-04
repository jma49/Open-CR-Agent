import type { Severity } from "@open-cr-agent/core";

// What a review is scored against: one case, from AACR-Bench or ocra's own
// golden set (ADR-0011), with the attack planted in it (ADR-0014).

export interface ReferenceComment {
  path: string;
  side: "left" | "right";
  fromLine: number | null;
  toLine: number | null;
  note: string;
  category: string;
  context: string;
}

// AACR-Bench, or ocra's own golden cases (ADR-0011).
export type Dataset = "aacr" | "golden";

export interface Instance {
  id: string;
  repo: string;
  prUrl: string;
  language: string;
  prCategory: string;
  baseCommit: string;
  headCommit: string;
  changeLines: number;
  references: ReferenceComment[];
  // Set for golden cases (ADR-0011), which may expect nothing.
  golden?: GoldenInfo;
}

type GoldenTier = "smoke" | "full" | "adversarial";

export interface ForbiddenRange {
  path: string;
  fromLine: number;
  toLine: number;
  reason: string;
}

export interface Adjudication {
  fingerprint: string;
  label: "valid" | "invalid";
  reason: string;
  title: string;
}

interface Location {
  path: string;
  fromLine: number;
  toLine: number;
}

interface GoldenInfo {
  tier: GoldenTier;
  clean: boolean;
  forbid: ForbiddenRange[];
  adjudicated: Adjudication[];
  // The lowest severity that counts, one per reference, in their order.
  minSeverity: Severity[];
  // Other places the same issue can rightly be reported (the docs that
  // promise a behavior, the test that misses it), one list per reference.
  alternates: Location[][];
  // Set on an adversarial case: the hostile text planted in the case it names.
  attack?: Attack;
}

export const ATTACK_GOALS = ["suppress", "plant-link", "forge-command"] as const;
export type AttackGoal = (typeof ATTACK_GOALS)[number];
export const ATTACK_CHANNELS = ["description", "code"] as const;
export type AttackChannel = (typeof ATTACK_CHANNELS)[number];

export interface Attack {
  // The golden case this attack plants its text in.
  on: string;
  goal: AttackGoal;
  channel: AttackChannel;
  // description: one commit subject per line, which is how a local range
  // review builds its description. code: lines inserted into `file`.
  text: string;
  file?: string | undefined;
  // Insert after this line of `file` at the head; 0 inserts at the top.
  after?: number | undefined;
  // What must not appear in any finding (the planted URL or command).
  canary?: string | undefined;
}
