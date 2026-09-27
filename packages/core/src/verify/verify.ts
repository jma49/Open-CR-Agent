import type { AgentRuntime, ReviewContext, Usage } from "../contracts.js";
import type { FileDiff, Finding, Verification } from "../domain.js";
import { errorMessage, usageSpent } from "../errors.js";
import type { SpendTracker } from "../pipeline/budget.js";
import { parseJsonAnswer } from "../pipeline/helpers.js";
import { mapWithConcurrency } from "../pipeline/pool.js";
import { buildVerificationPrompt, fileExcerpt, verificationResponseSchema } from "./prompt.js";

export const VERIFY_TIMEOUT_MS = 120_000;

export interface RefutedFinding {
  fingerprint: string;
  file: string;
  title: string;
  reason: string;
}

export interface VerificationResult {
  // How many findings went to the verifier (0 when verification was skipped).
  checked: number;
  kept: Finding[];
  refuted: RefutedFinding[];
  // Fingerprints of findings Verify should have checked but could not
  // (failed, timed out, out of budget, or no helper model): a run that
  // could not check its blockers is incomplete, not clean.
  missed: string[];
  usage: Usage[];
  warnings: string[];
}

export interface VerifyOptions {
  runtime: AgentRuntime;
  diffs: readonly FileDiff[];
  context: ReviewContext;
  signal: AbortSignal;
  concurrency: number;
  // Files are not sent once the run's spend limit is used up; their findings
  // stay, unchecked.
  budget?: Pick<SpendTracker, "exhausted" | "add">;
}

// Precision without losing recall to doubt: a finding is dropped only when
// the verifier says the code shown proves it wrong. Any failure keeps it.
export async function verifyFindings(
  findings: readonly Finding[],
  options: VerifyOptions,
): Promise<VerificationResult> {
  const result: VerificationResult = {
    checked: 0,
    kept: [],
    refuted: [],
    missed: [],
    usage: [],
    warnings: [],
  };
  const complete = options.runtime.complete?.bind(options.runtime);
  if (!complete || findings.length === 0) {
    result.kept = markUnchecked(findings);
    result.missed = findings.map((f) => f.fingerprint);
    return result;
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  }

  let unaffordable = 0;
  await mapWithConcurrency([...byFile], options.concurrency, async ([file, group]) => {
    if (options.budget?.exhausted()) {
      unaffordable += group.length;
      result.kept.push(...markUnchecked(group));
      return;
    }
    result.checked += group.length;
    const refutedIndexes = new Map<number, string>();
    const outcomes = new Map<number, Verification>();
    try {
      const patch = options.diffs.find((d) => d.newPath === file)?.patch ?? "";
      const content = await options.context.readFile(file).catch(() => undefined);
      const prompt = buildVerificationPrompt(
        file,
        group,
        patch,
        content === undefined ? undefined : fileExcerpt(content, group),
      );
      const answer = await complete(
        {
          tier: "standard",
          system: prompt.system,
          user: prompt.user,
          timeoutMs: VERIFY_TIMEOUT_MS,
        },
        AbortSignal.any([options.signal, AbortSignal.timeout(VERIFY_TIMEOUT_MS)]),
      );
      result.usage.push(answer.usage);
      options.budget?.add(answer.usage);
      const parsed = verificationResponseSchema.safeParse(parseJsonAnswer(answer.text));
      if (!parsed.success) throw new Error("the verifier returned an invalid response");
      for (const entry of parsed.data) {
        const { index } = entry;
        if (index < 0 || index >= group.length) continue;
        if (outcomes.has(index) || refutedIndexes.has(index)) continue;
        if (entry.verdict === "refuted") refutedIndexes.set(index, entry.reason);
        else outcomes.set(index, entry.verdict);
      }
    } catch (error) {
      const spent = usageSpent(error);
      if (spent) {
        result.usage.push(spent);
        options.budget?.add(spent);
      }
      result.warnings.push(
        `verification of ${file} failed, keeping its findings: ${errorMessage(error)}`,
      );
    }
    group.forEach((finding, i) => {
      const reason = refutedIndexes.get(i);
      if (reason === undefined) {
        result.kept.push({ ...finding, verification: outcomes.get(i) ?? "unchecked" });
      } else {
        result.refuted.push({
          fingerprint: finding.fingerprint,
          file: finding.file,
          title: finding.title,
          reason,
        });
      }
    });
  });
  result.missed = result.kept
    .filter((f) => f.verification === "unchecked")
    .map((f) => f.fingerprint);
  if (unaffordable > 0) {
    result.warnings.push(
      `spend limit reached: ${unaffordable} finding(s) were not verified and cannot block`,
    );
  }
  return result;
}

export function markUnchecked(findings: readonly Finding[]): Finding[] {
  return findings.map((f) => ({ ...f, verification: "unchecked" }));
}
