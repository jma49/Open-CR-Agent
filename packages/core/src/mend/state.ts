// The loop's caps (ADR-0078 points 5 and 8).
export const MEND_LIMITS = {
  attemptsPerItem: 2,
  rounds: 6,
  itemsPerRound: 5,
  files: 10,
  addedLines: 200,
} as const;

// Why an item takes no further round: a person has to decide, or its code is
// no longer at the head.
type Closed = "needs_human" | "gone";

export interface ItemState {
  attempts: number;
  closed?: Closed | undefined;
}

// What the loop remembers of a change request between rounds. The scheduler
// keeps it and passes it back; a round returns the next one.
export interface MendState {
  rounds: number;
  costUsd: number;
  items: Readonly<Record<string, ItemState>>;
}

export const EMPTY_STATE: MendState = { rounds: 0, costUsd: 0, items: {} };

export const ROUND_STOPS = ["rounds", "spend"] as const;
export type RoundStop = (typeof ROUND_STOPS)[number];

export function roundStop(state: MendState, maxCostUsd: number | undefined): RoundStop | undefined {
  if (state.rounds >= MEND_LIMITS.rounds) return "rounds";
  if (maxCostUsd !== undefined && state.costUsd >= maxCostUsd) return "spend";
  return undefined;
}

// An item with every attempt used is closed for a person, whatever it was.
export function closedAs(item: ItemState | undefined): Closed | undefined {
  if (!item) return undefined;
  return item.closed ?? (item.attempts >= MEND_LIMITS.attemptsPerItem ? "needs_human" : undefined);
}
