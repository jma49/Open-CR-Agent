import type { AgentRuntime, ReviewContext, Usage } from "../contracts.js";
import type { FileDiff, Finding } from "../domain.js";
import { errorMessage } from "../errors.js";
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
  usage: Usage[];
  warnings: string[];
}

export interface VerifyOptions {
  runtime: AgentRuntime;
  diffs: readonly FileDiff[];
  context: ReviewContext;
  signal: AbortSignal;
  concurrency: number;
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
    usage: [],
    warnings: [],
  };
  const complete = options.runtime.complete?.bind(options.runtime);
  if (!complete || findings.length === 0) {
    result.kept = [...findings];
    return result;
  }
  result.checked = findings.length;

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);
  }

  await mapWithConcurrency([...byFile], options.concurrency, async ([file, group]) => {
    const refutedIndexes = new Map<number, string>();
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
      const parsed = verificationResponseSchema.safeParse(parseJsonAnswer(answer.text));
      if (!parsed.success) throw new Error("the verifier returned an invalid response");
      for (const entry of parsed.data) {
        if (entry.verdict === "refuted" && entry.index >= 0 && entry.index < group.length) {
          refutedIndexes.set(entry.index, entry.reason);
        }
      }
    } catch (error) {
      result.warnings.push(
        `verification of ${file} failed, keeping its findings: ${errorMessage(error)}`,
      );
    }
    group.forEach((finding, i) => {
      const reason = refutedIndexes.get(i);
      if (reason === undefined) {
        result.kept.push(finding);
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
  return result;
}
