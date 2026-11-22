import { parseJsonAnswer } from "../agent/json.js";
import { oneShot } from "../agent/model-call.js";
import { mapWithConcurrency } from "../agent/pool.js";
import type { AgentCallSettings } from "../agent/settings.js";
import type { SpendLimit } from "../agent/spend-limit.js";
import type { AgentRuntime, ReviewContext, SyntaxChecker, Usage } from "../contracts.js";
import type { FileDiff, Finding, FindingFix } from "../domain.js";
import { errorMessage, OcraError } from "../errors.js";
import { checkFix, type FixRejection } from "./check.js";
import { buildFixPrompt, fixResponseSchema } from "./prompt.js";
import { type FixCandidate, fixCandidates } from "./select.js";

const FIX_TIMEOUT_MS = 120_000;

export interface FixSummary {
  // Findings a fix was asked for.
  asked: number;
  proposed: number;
  rejected: { fingerprint: string; reason: FixRejection }[];
}

export interface FixResult {
  findings: Finding[];
  summary: FixSummary;
  usage: Usage[];
  warnings: string[];
}

export interface FixOptions {
  runtime: AgentRuntime;
  syntax: SyntaxChecker;
  diffs: readonly FileDiff[];
  context: ReviewContext;
  signal: AbortSignal;
  concurrency: number;
  maxFixes: number;
  spendLimit?: Pick<SpendLimit, "mayCall" | "charge">;
  call?: AgentCallSettings | undefined;
}

// One call per file with candidates, then every answer checked on its own
// (checkFix): a fix the checks refuse is dropped, never repaired, and a
// failure leaves the findings as they were.
export async function proposeFixes(
  findings: readonly Finding[],
  options: FixOptions,
): Promise<FixResult> {
  const summary: FixSummary = { asked: 0, proposed: 0, rejected: [] };
  const result: FixResult = { findings: [...findings], summary, usage: [], warnings: [] };
  const ask = oneShot(options.runtime, (usage) => {
    result.usage.push(usage);
    options.spendLimit?.charge(usage);
  });
  const candidates = fixCandidates(findings, options.maxFixes);
  if (!ask || candidates.length === 0) return result;

  const byFile = new Map<string, FixCandidate[]>();
  for (const c of candidates) byFile.set(c.file, [...(byFile.get(c.file) ?? []), c]);
  const reject = (group: readonly FixCandidate[], reason: FixRejection) => {
    for (const f of group) summary.rejected.push({ fingerprint: f.fingerprint, reason });
  };
  const fixes = new Map<string, FindingFix>();
  let unaffordable = 0;

  await mapWithConcurrency([...byFile], options.concurrency, async ([file, group]) => {
    const content = await options.context.readFile(file).catch(() => undefined);
    if (content === undefined) return reject(group, "stale");
    if ((await options.syntax.errors(file, content)) === undefined) {
      return reject(group, "no_parser");
    }
    if (options.spendLimit && !options.spendLimit.mayCall()) {
      unaffordable += group.length;
      return;
    }
    summary.asked += group.length;
    let answers: Map<number, string | null>;
    try {
      const patch = options.diffs.find((d) => d.newPath === file)?.patch ?? "";
      const prompt = buildFixPrompt(file, group, content, patch);
      const text = await ask(
        {
          tier: "standard",
          agent: "fixer",
          call: options.call,
          system: prompt.system,
          user: prompt.user,
          timeoutMs: FIX_TIMEOUT_MS,
        },
        options.signal,
      );
      answers = indexedAnswers(text);
    } catch (error) {
      result.warnings.push(`proposing fixes for ${file} failed: ${errorMessage(error)}`);
      return reject(group, "failed");
    }
    for (const [i, finding] of group.entries()) {
      const proposed = answers.get(i);
      if (proposed === undefined || proposed === null) {
        reject([finding], "declined");
        continue;
      }
      const checked = await checkFix(finding, content, proposed, options.syntax);
      if ("fix" in checked) fixes.set(finding.id, checked.fix);
      else reject([finding], checked.rejected);
    }
  });

  summary.proposed = fixes.size;
  result.findings = findings.map((f) => {
    const fix = fixes.get(f.id);
    return fix ? { ...f, fix } : f;
  });
  if (unaffordable > 0) {
    result.warnings.push(`spend limit reached: no fix was proposed for ${unaffordable} finding(s)`);
  }
  return result;
}

// The first answer for each index wins.
function indexedAnswers(text: string): Map<number, string | null> {
  const parsed = fixResponseSchema.safeParse(parseJsonAnswer(text));
  if (!parsed.success) {
    throw new OcraError("RUNTIME_INVALID_OUTPUT", "the fixer returned an invalid response");
  }
  const answers = new Map<number, string | null>();
  for (const { index, replacement } of parsed.data) {
    if (!answers.has(index)) answers.set(index, replacement);
  }
  return answers;
}
