import { errorMessage, type Learning } from "@open-cr-agent/core";
import {
  type DraftLearning,
  type LearningDraft,
  type LearningEvidence,
  learningSelector,
  mapWithConcurrency,
} from "@open-cr-agent/core/internal";

// What a source found, read only once it is drafted.
export interface Candidate {
  ref: string;
  evidence(): Promise<LearningEvidence>;
}

export interface LearnOptions {
  existing: readonly Learning[];
  // Learnings proposed for the default branch and not merged into it.
  proposed: readonly Learning[];
  max: number;
  // Drafts in flight at once; under a spend limit 1, so it is never passed.
  concurrency: number;
  draft: DraftLearning;
  // Asked before each draft call: false once the spend limit is used up.
  mayCall(): boolean;
  signal: AbortSignal;
  warn(message: string): void;
}

export interface LearnResult {
  kept: LearningDraft[];
  // Candidates an existing learning already records.
  recorded: number;
  // Candidates a proposed learning records.
  proposed: number;
  drafted: number;
  declined: number;
  duplicates: number;
  // Drafts the selection would not give to the change they came from.
  unselected: number;
  failed: number;
  // Candidates left undrafted by the spend limit.
  unaffordable: number;
}

type Outcome =
  | { kind: "draft"; draft: LearningDraft; evidence: LearningEvidence }
  | { kind: "declined" | "failed" | "unaffordable" };

// One pipeline for every source (ADR-0040): draft, deduplicate, replay.
// Writing is the caller's.
export async function learnFrom(
  candidates: readonly Candidate[],
  options: LearnOptions,
): Promise<LearnResult> {
  const recorded = (learnings: readonly Learning[]) => (c: Candidate) =>
    learnings.some((l) => records(l, c.ref));
  const unrecorded = candidates.filter((c) => !recorded(options.existing)(c));
  const fresh = unrecorded.filter((c) => !recorded(options.proposed)(c));
  const chosen = fresh.slice(0, options.max);
  const outcomes = await mapWithConcurrency(chosen, options.concurrency, (c) =>
    draftOne(c, options),
  );
  const result: LearnResult = {
    kept: [],
    recorded: candidates.length - unrecorded.length,
    proposed: unrecorded.length - fresh.length,
    drafted: 0,
    declined: 0,
    duplicates: 0,
    unselected: 0,
    failed: 0,
    unaffordable: 0,
  };
  const known: { paths: readonly string[]; title: string }[] = [
    ...options.existing,
    ...options.proposed,
  ];
  for (const outcome of outcomes) {
    if (outcome.kind !== "draft") {
      result[outcome.kind]++;
      continue;
    }
    result.drafted++;
    const { draft, evidence } = outcome;
    if (known.some((k) => isDuplicate(k, draft))) result.duplicates++;
    else if (!replays(draft, evidence)) result.unselected++;
    else {
      result.kept.push(draft);
      known.push(draft);
    }
  }
  return result;
}

async function draftOne(candidate: Candidate, options: LearnOptions): Promise<Outcome> {
  if (options.signal.aborted || !options.mayCall()) return { kind: "unaffordable" };
  try {
    const evidence = await candidate.evidence();
    const draft = await options.draft(evidence, options.signal);
    return draft ? { kind: "draft", draft, evidence } : { kind: "declined" };
  } catch (error) {
    options.warn(`${candidate.ref} could not be drafted: ${errorMessage(error)}`);
    return { kind: "failed" };
  }
}

const HEX = /^[0-9a-f]{7,40}$/;

// A commit is recorded under its full or its abbreviated name.
function records(learning: Learning, ref: string): boolean {
  const recorded = learning.source?.ref;
  if (recorded === undefined) return false;
  if (recorded === ref) return true;
  return (
    HEX.test(recorded) && HEX.test(ref) && (recorded.startsWith(ref) || ref.startsWith(recorded))
  );
}

// The same lesson drafted twice, or one the team already wrote: it covers
// a path the other does, and most of the words of their titles are shared.
function isDuplicate(
  known: { paths: readonly string[]; title: string },
  draft: LearningDraft,
): boolean {
  if (!draft.paths.some((p) => known.paths.includes(p))) return false;
  const a = titleWords(known.title);
  const b = titleWords(draft.title);
  const shared = [...a].filter((w) => b.has(w)).length;
  const all = new Set([...a, ...b]).size;
  return all > 0 && shared / all >= 0.5;
}

function titleWords(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4));
}

// Kept only if the selection gives it to the change it came from: a
// learning that does not reach its own change would reach no other.
function replays(draft: LearningDraft, evidence: LearningEvidence): boolean {
  const learning: Learning = { id: "draft", critical: false, ...draft };
  return learningSelector([learning])(evidence.files).selected.length === 1;
}
