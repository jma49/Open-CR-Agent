import { parseJsonAnswer } from "../agent/json.js";
import { oneShot } from "../agent/model-call.js";
import type { AgentCallSettings } from "../agent/settings.js";
import { at } from "../at.js";
import type { AgentRuntime, Usage } from "../contracts.js";
import type {
  ChangeRequest,
  Finding,
  PriorFinding,
  RiskTier,
  Severity,
  Verdict,
} from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import { buildJudgePrompt, type JudgeResponse, judgeResponseSchema } from "./prompt.js";
import { decideVerdict, defaultSummary } from "./verdict.js";

const JUDGE_TIMEOUT_MS = 180_000;

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
  call?: AgentCallSettings | undefined;
  // --ultra: keep what the judge would drop, marked low confidence.
  keepDropped?: boolean;
  // Earlier findings still open but not reported this time; the judge does
  // not see them, the verdict counts them.
  carried?: readonly PriorFinding[];
}

export async function judgeFindings(
  findings: readonly Finding[],
  options: JudgeOptions,
): Promise<JudgeResult> {
  const carried = options.carried ?? [];
  const fallback = (warnings: string[] = [], usage: Usage[] = []): JudgeResult => ({
    findings: [...findings],
    verdict: decideVerdict([...findings, ...carried]),
    summary: defaultSummary(findings, carried.length),
    usage,
    warnings,
  });
  const usage: Usage[] = [];
  const ask = oneShot(options.runtime, (u) => usage.push(u));
  if (!options.enabled || !ask || findings.length === 0) return fallback();

  const prompt = buildJudgePrompt(options.changeRequest, options.tier, findings);
  let response: JudgeResponse;
  try {
    const answer = await ask(
      {
        tier: "top",
        agent: "judge",
        call: options.call,
        system: prompt.system,
        user: prompt.user,
        timeoutMs: JUDGE_TIMEOUT_MS,
      },
      options.signal,
    );
    const parsed = judgeResponseSchema.safeParse(parseJsonAnswer(answer));
    if (!parsed.success)
      throw new OcraError("RUNTIME_INVALID_OUTPUT", "the judge returned an invalid response");
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
    verdict: decideVerdict([...judged.findings.filter((f) => !f.lowConfidence), ...carried]),
    summary: response.summary.trim() || defaultSummary(judged.findings),
    decisions: judged.decisions,
    usage,
    warnings: judged.warnings,
  };
}

// A critical finding the verifier confirmed is never dropped and never
// downgraded: the judge reads text the change's author controls, and either
// would take a blocking finding out of the verdict.
function protectedFinding(f: Finding): boolean {
  return f.severity === "critical" && f.verification === "confirmed";
}

// Indexes come from a model: out-of-range, repeated or conflicting ones are
// ignored rather than trusted.
export function applyDecisions(
  findings: readonly Finding[],
  response: JudgeResponse,
): { findings: Finding[]; decisions: JudgeDecisions; warnings: string[] } {
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < findings.length;
  const decisions: JudgeDecisions = { merged: [], dropped: [], recalibrated: [] };
  const warnings: string[] = [];
  const removed = new Set<number>();
  const isProtected = (i: number) => protectedFinding(at(findings, i));

  for (const group of response.duplicates) {
    const members = [...new Set(group.filter(valid))].filter((i) => !removed.has(i));
    // Merging keeps one member; keep a protected one so it is not merged away.
    const first = members.findIndex(isProtected);
    if (first > 0) members.unshift(...members.splice(first, 1));
    const [keep, ...rest] = members;
    if (keep === undefined || rest.length === 0) continue;
    for (const i of rest) removed.add(i);
    decisions.merged.push({
      kept: at(findings, keep).fingerprint,
      merged: rest.map((i) => at(findings, i).fingerprint),
    });
  }

  for (const { index, reason } of response.drop) {
    if (!valid(index) || removed.has(index)) continue;
    if (isProtected(index)) {
      warnings.push(
        `judge tried to drop the confirmed critical finding ${at(findings, index).fingerprint.slice(0, 8)}; kept it`,
      );
      continue;
    }
    removed.add(index);
    const f = at(findings, index);
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
    if (isProtected(i)) {
      warnings.push(
        `judge tried to downgrade the confirmed critical finding ${finding.fingerprint.slice(0, 8)} to ${change.severity}; kept it critical`,
      );
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
  return { findings: kept, decisions, warnings };
}
