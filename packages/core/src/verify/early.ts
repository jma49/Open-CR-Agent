import { oneShot } from "../agent/model-call.js";
import { limiter } from "../agent/pool.js";
import type { Usage } from "../contracts.js";
import type { Finding, Verification } from "../domain.js";
import {
  type FileVerification,
  missedOf,
  refutedFinding,
  type VerificationResult,
  type VerifyOptions,
  verifyFile,
  verifyFindings,
} from "./verify.js";

// Verification that starts while review tasks still run (ADR-0074): a file's
// findings are checked as soon as they are handed over, and a finding is
// checked once, so what a watcher was shown early cannot be checked again
// with another answer.

type Outcome = { verification: Verification; preExisting?: true } | { refuted: string };

export interface EarlyVerification {
  outcomes: ReadonlyMap<string, Outcome>;
  usage: Usage[];
  warnings: string[];
}

export interface EarlyVerifier {
  // Ids handed over so far, answered or not.
  readonly submitted: ReadonlySet<string>;
  // False once the spend limit refuses the call: the findings wait for Verify.
  verify(file: string, group: readonly Finding[]): boolean;
  // Every call made so far, answered.
  result(): Promise<EarlyVerification>;
}

// Undefined when the runtime makes no plain completions.
export function earlyVerifier(
  options: VerifyOptions,
  onFile: (file: string, verified: FileVerification) => void,
): EarlyVerifier | undefined {
  const usage: Usage[] = [];
  const ask = oneShot(options.runtime, (spent) => {
    usage.push(spent);
    options.spendLimit?.charge(spent);
  });
  if (!ask) return undefined;
  const limited = limiter(options.concurrency);
  const submitted = new Set<string>();
  const outcomes = new Map<string, Outcome>();
  const warnings: string[] = [];
  const calls: Promise<void>[] = [];
  return {
    submitted,
    verify(file, group) {
      if (options.spendLimit && !options.spendLimit.mayCall()) return false;
      for (const finding of group) submitted.add(finding.id);
      calls.push(
        limited(() => verifyFile(file, group, options, ask)).then((verified) => {
          for (const f of verified.kept) {
            outcomes.set(f.id, {
              verification: f.verification ?? "unchecked",
              ...(f.preExisting ? { preExisting: true as const } : {}),
            });
          }
          for (const { finding, reason } of verified.refuted) {
            outcomes.set(finding.id, { refuted: reason });
          }
          if (verified.warning) warnings.push(verified.warning);
          onFile(file, verified);
        }),
      );
      return true;
    },
    async result() {
      await Promise.all(calls);
      return { outcomes, usage, warnings };
    },
  };
}

// Verify for the findings the early calls did not answer, and both as one result.
export async function verifyRemaining(
  findings: readonly Finding[],
  early: EarlyVerification | undefined,
  options: VerifyOptions,
): Promise<VerificationResult> {
  if (!early) return verifyFindings(findings, options);
  const rest = await verifyFindings(
    findings.filter((f) => !early.outcomes.has(f.id)),
    options,
  );
  const later = new Map(rest.kept.map((f) => [f.id, f]));
  const result: VerificationResult = {
    checked: rest.checked,
    kept: [],
    refuted: [...rest.refuted],
    missed: [],
    usage: [...early.usage, ...rest.usage],
    warnings: [...early.warnings, ...rest.warnings],
  };
  for (const finding of findings) {
    const outcome = early.outcomes.get(finding.id);
    if (!outcome) {
      const kept = later.get(finding.id);
      if (kept) result.kept.push(kept);
      continue;
    }
    result.checked += 1;
    if ("refuted" in outcome) {
      result.refuted.push(refutedFinding({ finding, reason: outcome.refuted }));
    } else {
      result.kept.push({ ...finding, ...outcome });
    }
  }
  result.missed = missedOf(result.kept);
  return result;
}
