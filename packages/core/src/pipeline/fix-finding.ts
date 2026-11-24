import { oneShot } from "../agent/model-call.js";
import { type AgentCallSettings, roleCall } from "../agent/settings.js";
import { type SpendLimit, spendLimit } from "../agent/spend-limit.js";
import { matchInContent, matchInHunks } from "../anchor/match.js";
import { quoteSignature } from "../anchor/quote.js";
import type { AgentRuntime, ReviewContext, SyntaxChecker, Usage } from "../contracts.js";
import type { FileDiff, FindingFix, LineRange, Severity } from "../domain.js";
import { type CallFailure, OcraError } from "../errors.js";
import type { FixRejection } from "../fix/check.js";
import { proposeFixes } from "../fix/propose.js";
import { type FixCandidate, MAX_FIX_SPAN_LINES } from "../fix/select.js";
import type { VcsAdapter } from "../vcs.js";
import { reviewContext } from "./context.js";
import type { ReviewOptions } from "./options.js";

// A finding as stored after a review: its text, and the code it quoted.
export interface StoredFinding {
  fingerprint: string;
  reviewer: string;
  severity: Severity;
  category: string;
  file: string;
  title: string;
  body: string;
  suggestion?: string;
  // The code the finding quoted; absent, it cannot be found again.
  existingCode?: string;
  lowConfidence?: boolean;
  // The stored text was redacted or cut, so its quote may not be the code.
  altered?: boolean;
}

type FixFindingOutcome = "proposed" | "rejected" | "not_fixable" | "stale" | "head_moved";
type FixFindingReason = FixRejection | "not_candidate";

export interface FixedFinding {
  headSha: string;
  outcome: FixFindingOutcome;
  fix?: FindingFix;
  reason?: FixFindingReason;
  // What failed, for the reason `failed`.
  cause?: CallFailure;
  warnings: string[];
}

interface FixFindingOptions extends Pick<ReviewOptions, "effort" | "roles"> {
  finding: StoredFinding;
  vcs: VcsAdapter;
  runtime: AgentRuntime;
  syntax: SyntaxChecker;
  // The head the finding was reviewed at; another one answers head_moved.
  expectedHead?: string;
  maxCostUsd?: number;
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

const OUTCOME_OF: Record<FixFindingReason, FixFindingOutcome> = {
  declined: "not_fixable",
  no_parser: "not_fixable",
  not_candidate: "not_fixable",
  stale: "stale",
  failed: "rejected",
  unchanged: "rejected",
  unsafe: "rejected",
  too_large: "rejected",
  syntax: "rejected",
};

// A checked fix for one stored finding (ADR-0077): the finding is anchored
// again at the head by the review's rules, and a fix is asked only for one
// the fix stage would ask for (fixCandidates), whether or not it had a fix.
export async function fixFinding(options: FixFindingOptions): Promise<FixedFinding> {
  const { vcs, finding } = options;
  if (!oneShot(options.runtime, () => {})) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `the ${options.runtime.name} runtime makes no plain completions, which ocra fix needs`,
    );
  }
  const { headSha } = await vcs.getChangeRequest();
  if (options.expectedHead !== undefined && options.expectedHead !== headSha) {
    return { headSha, outcome: "head_moved", warnings: [] };
  }
  const diffs = await vcs.getDiff();
  const fixed = await fixAtHead(finding, {
    runtime: options.runtime,
    syntax: options.syntax,
    diffs,
    context: reviewContext(vcs, diffs),
    spendLimit: spendLimit(options.maxCostUsd),
    call: roleCall("fixer", options),
    signal: options.signal,
    onUsage: options.onUsage,
  });
  if ("fix" in fixed) return { headSha, outcome: "proposed", ...fixed };
  return { headSha, outcome: OUTCOME_OF[fixed.reason], ...fixed };
}

interface HeadFixOptions {
  runtime: AgentRuntime;
  syntax: SyntaxChecker;
  diffs: readonly FileDiff[];
  context: ReviewContext;
  spendLimit: Pick<SpendLimit, "mayCall" | "charge">;
  call: AgentCallSettings;
  signal: AbortSignal;
  onUsage: (usage: Usage) => void;
}

type HeadFix =
  | { fix: FindingFix; warnings: string[] }
  | { reason: FixFindingReason; cause?: CallFailure; warnings: string[] };

// The fix for one stored finding in a change already read: the finding is
// anchored again by its quote, asked for through proposeFixes and checked.
export async function fixAtHead(finding: StoredFinding, options: HeadFixOptions): Promise<HeadFix> {
  const { diffs, context } = options;
  if (finding.lowConfidence) return { reason: "not_candidate", warnings: [] };
  let content: string | undefined;
  try {
    content = await context.readFile(finding.file);
  } catch {
    // The access policy refuses it: no review read it, and no fix will.
    return { reason: "not_candidate", warnings: [] };
  }
  if (content === undefined) return { reason: "stale", warnings: [] };
  const located = locate(finding, diffs, content);
  if (typeof located === "string") return { reason: located, warnings: [] };
  const lineRange = located.range;

  const quote = quoteSignature(content, lineRange);
  const candidate: FixCandidate = {
    id: finding.fingerprint,
    fingerprint: finding.fingerprint,
    reviewer: finding.reviewer,
    category: finding.category,
    severity: finding.severity,
    file: finding.file,
    existingCode: finding.existingCode ?? "",
    title: finding.title,
    body: finding.body,
    ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
    evidence: [],
    lineRange,
    ...(quote ? { quote } : {}),
    provenance: { task: "fix" },
    anchor: { method: "hunk", inDiff: true },
    status: "new",
  };
  const result = await proposeFixes([candidate], {
    runtime: options.runtime,
    syntax: options.syntax,
    diffs,
    context,
    signal: options.signal,
    concurrency: 1,
    maxFixes: 1,
    spendLimit: options.spendLimit,
    call: options.call,
  });
  for (const usage of result.usage) options.onUsage(usage);
  const fix = result.findings[0]?.fix;
  if (fix) return { fix, warnings: result.warnings };
  const [rejected] = result.summary.rejected;
  return {
    reason: rejected?.reason ?? "failed",
    ...(rejected?.cause ? { cause: rejected.cause } : {}),
    warnings: result.warnings,
  };
}

// Where the finding's quote is at the head. Only a quote that fits one place
// in the change's hunks is a candidate, as anchoring by "hunk" is; a quote
// found nowhere in the file is stale, unless the stored text was altered.
function locate(
  finding: StoredFinding,
  diffs: readonly FileDiff[],
  content: string,
): { range: LineRange } | FixFindingReason {
  const code = finding.existingCode ?? "";
  if (code.trim() === "") return "not_candidate";
  const own = diffs.find((d) => d.newPath === finding.file);
  const inHunk = own ? matchInHunks(own, code) : undefined;
  if (inHunk?.kind === "found") {
    const { range } = inHunk;
    return range.end - range.start < MAX_FIX_SPAN_LINES ? { range } : "not_candidate";
  }
  if (inHunk?.kind === "ambiguous") return "not_candidate";
  if (matchInContent(content, code).kind !== "none") return "not_candidate";
  return finding.altered ? "not_candidate" : "stale";
}
