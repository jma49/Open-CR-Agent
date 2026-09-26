import type { AgentRuntime, Usage } from "../contracts.js";
import type { ChangeRequest, Finding, RiskTier, Severity, Verdict } from "../domain.js";
import { errorMessage } from "../errors.js";
import { parseJsonAnswer } from "../pipeline/helpers.js";
import { buildJudgePrompt, type JudgeResponse, judgeResponseSchema } from "./prompt.js";
import { decideVerdict, defaultSummary } from "./verdict.js";

export const JUDGE_TIMEOUT_MS = 180_000;

export interface JudgeDecisions {
  merged: { kept: string; merged: string[] }[];
  dropped: { fingerprint: string; file: string; title: string; reason: string }[];
  recalibrated: { fingerprint: string; from: Severity; to: Severity; reason: string }[];
}

export interface JudgeResult {
  findings: Finding[];
  verdict: Verdict;
  summary: string;
  // Undefined when the judge did not run: no findings, disabled, or failed.
  decisions?: JudgeDecisions;
  usage: Usage[];
  warnings: string[];
}

export interface JudgeOptions {
  runtime: AgentRuntime;
  changeRequest: ChangeRequest;
  tier: RiskTier;
  signal: AbortSignal;
  enabled: boolean;
  // --ultra: keep what the judge would drop, marked low confidence.
  keepDropped?: boolean;
}

export async function judgeFindings(
  findings: readonly Finding[],
  options: JudgeOptions,
): Promise<JudgeResult> {
  const fallback = (warnings: string[] = [], usage: Usage[] = []): JudgeResult => ({
    findings: [...findings],
    verdict: decideVerdict(findings),
    summary: defaultSummary(findings),
    usage,
    warnings,
  });
  const complete = options.runtime.complete?.bind(options.runtime);
  if (!options.enabled || !complete || findings.length === 0) return fallback();

  const prompt = buildJudgePrompt(options.changeRequest, options.tier, findings);
  let usage: Usage[] = [];
  let response: JudgeResponse;
  try {
    const answer = await complete(
      { tier: "top", system: prompt.system, user: prompt.user, timeoutMs: JUDGE_TIMEOUT_MS },
      AbortSignal.any([options.signal, AbortSignal.timeout(JUDGE_TIMEOUT_MS)]),
    );
    usage = [answer.usage];
    const parsed = judgeResponseSchema.safeParse(parseJsonAnswer(answer.text));
    if (!parsed.success) throw new Error("the judge returned an invalid response");
    response = parsed.data;
  } catch (error) {
    return fallback([`judge failed, reporting findings unjudged: ${errorMessage(error)}`], usage);
  }

  const judged = applyDecisions(findings, response);
  if (options.keepDropped) {
    const dropped = new Set(judged.decisions.dropped.map((d) => d.fingerprint));
    judged.findings.push(
      ...findings
        .filter((f) => dropped.has(f.fingerprint))
        .map((f) => ({ ...f, lowConfidence: true })),
    );
  }
  return {
    findings: judged.findings,
    // Low-confidence extras are shown, not counted: the verdict stays precise.
    verdict: decideVerdict(judged.findings.filter((f) => !f.lowConfidence)),
    summary: response.summary.trim() || defaultSummary(judged.findings),
    decisions: judged.decisions,
    usage,
    warnings: [],
  };
}

// Indexes come from a model: out-of-range, repeated or conflicting ones are
// ignored rather than trusted.
export function applyDecisions(
  findings: readonly Finding[],
  response: JudgeResponse,
): { findings: Finding[]; decisions: JudgeDecisions } {
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < findings.length;
  const decisions: JudgeDecisions = { merged: [], dropped: [], recalibrated: [] };
  const removed = new Set<number>();

  for (const group of response.duplicates) {
    const members = [...new Set(group.filter(valid))].filter((i) => !removed.has(i));
    const [keep, ...rest] = members;
    if (keep === undefined || rest.length === 0) continue;
    for (const i of rest) removed.add(i);
    decisions.merged.push({
      kept: (findings[keep] as Finding).fingerprint,
      merged: rest.map((i) => (findings[i] as Finding).fingerprint),
    });
  }

  for (const { index, reason } of response.drop) {
    if (!valid(index) || removed.has(index)) continue;
    removed.add(index);
    const f = findings[index] as Finding;
    decisions.dropped.push({ fingerprint: f.fingerprint, file: f.file, title: f.title, reason });
  }

  const severities = new Map<number, { severity: Severity; reason: string }>();
  for (const entry of response.severity) {
    if (valid(entry.index) && !severities.has(entry.index)) severities.set(entry.index, entry);
  }

  const kept: Finding[] = [];
  findings.forEach((finding, i) => {
    if (removed.has(i)) return;
    const change = severities.get(i);
    if (!change || change.severity === finding.severity) {
      kept.push(finding);
      return;
    }
    decisions.recalibrated.push({
      fingerprint: finding.fingerprint,
      from: finding.severity,
      to: change.severity,
      reason: change.reason,
    });
    kept.push({ ...finding, severity: change.severity });
  });
  return { findings: kept, decisions };
}
