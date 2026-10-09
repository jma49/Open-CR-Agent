import type { Instance } from "./instance.js";
import { type DropStage, normalizePath, type SessionTrace } from "./session-trace.js";

// The recall funnel (#488): how far each expected finding got in a review,
// from its session log, so a miss says where it was lost. In order:
// not-looked (no task read its file), looked (read, nothing reported on it),
// raised (a task reported something at its location that did not reach the
// report as this issue), dropped (Filter, Verify, the judge or
// the bundle check took it out) and found (it reached the report, at any
// severity: the summary counts a finding below the case's minimum apart).
export const FUNNEL_STAGES = ["not-looked", "looked", "raised", "dropped", "found"] as const;
export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface ClaimStage {
  stage: FunnelStage;
  droppedBy?: DropStage;
}

// unknown: expected findings of reviews that kept no session log, so a run
// scored before logs were kept never reads as one that missed everything.
export type Funnel = Record<FunnelStage, number> & { unknown: number };

// By expected finding's index: found in the report, reported at its
// location and taken out (and where), reported there and kept.
export interface FunnelMatches {
  found: ReadonlyMap<number, unknown>;
  dropped: ReadonlyMap<number, DropStage>;
  raised: ReadonlyMap<number, unknown>;
}

export function claimStages(
  instance: Instance,
  trace: SessionTrace,
  matches: FunnelMatches,
): ClaimStage[] {
  return instance.references.map((reference, k): ClaimStage => {
    if (matches.found.has(k)) return { stage: "found" };
    const droppedBy = matches.dropped.get(k);
    if (droppedBy) return { stage: "dropped", droppedBy };
    if (matches.raised.has(k)) return { stage: "raised" };
    const paths = [reference.path, ...(instance.golden?.alternates[k] ?? []).map((a) => a.path)];
    return paths.some((p) => trace.read.has(normalizePath(p)))
      ? { stage: "looked" }
      : { stage: "not-looked" };
  });
}

export function countFunnel(claims: Iterable<{ stage?: FunnelStage | undefined }>): Funnel {
  const funnel: Funnel = {
    "not-looked": 0,
    looked: 0,
    raised: 0,
    dropped: 0,
    found: 0,
    unknown: 0,
  };
  for (const claim of claims) funnel[claim.stage ?? "unknown"] += 1;
  return funnel;
}
