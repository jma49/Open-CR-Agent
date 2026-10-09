import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  ReviewerCounts,
  ReviewSource,
  ReviewUpload,
  SharedFinding,
} from "@open-cr-agent/cloud-contract";
import { coverageGaps, type ReviewReport, type Verification } from "@open-cr-agent/core";
import { verificationSchema } from "@open-cr-agent/core/internal";
import { machineSecret } from "../io/private-file.js";
import { VERSION } from "../version.js";
import { CloudClient, CloudError, sessionLostReason } from "./client.js";
import { readCredentials } from "./credentials.js";
import type { CloudDeps } from "./deps.js";

// After a review, a signed-in CLI sends ocra Cloud its counts (ADR-0024):
// the verdict, how many findings of each severity, files and tasks, tokens
// and time. A path, a title, a finding's text or code go only when the
// account shares findings (ADR-0028, findings.ts). The repository is
// a salted hash of its `https://host/owner/repo` (repository-id.ts), so
// the server can group reviews of one repository without learning which
// it is: the salt stays on this machine, or is the account's while it
// shares findings, so the hash matches on all its machines.

export function uploadOf(
  report: ReviewReport,
  source: ReviewSource,
  repoHash: string,
  durationMs: number,
): ReviewUpload {
  const severity = (s: string) => report.findings.filter((f) => f.severity === s).length;
  const gaps = coverageGaps(report);
  return {
    runId: report.runId,
    repoHash,
    source,
    tier: report.tier,
    verdict: report.verdict,
    // As the exit code reads it: a review that missed files or could not
    // verify a critical finding is incomplete.
    complete: gaps.notReviewed === 0 && report.unverifiedCriticals === 0,
    findings: {
      critical: severity("critical"),
      warning: severity("warning"),
      suggestion: severity("suggestion"),
    },
    files: {
      reviewed: report.coverage.filter((c) => c.status === "reviewed").length,
      notReviewed: gaps.notReviewed,
    },
    tasks: {
      completed: report.tasks.filter((t) => t.status === "completed").length,
      failed: report.tasks.filter((t) => t.status === "failed" || t.status === "timed_out").length,
    },
    usage: {
      inputTokens: report.usage.inputTokens,
      outputTokens: report.usage.outputTokens,
      costUsd: report.usage.costUsd ?? 0,
    },
    durationMs: Math.round(durationMs),
    ocraVersion: VERSION,
    ...perReviewer(report),
  };
}

// Counted as `ocra metrics` counts one report: a failed or timed-out task is
// failed, a finding without a verification is unchecked, a dismissal outranks
// a fix, and a fixed or dismissed finding is attributed to the reviewer the
// earlier review recorded for it, else to the reviewer of a finding with its
// fingerprint in this report, else to none.
function perReviewer(
  report: ReviewReport,
): Required<Pick<ReviewUpload, "reviewers" | "verification" | "outcomes">> {
  const reviewers = new Map<string, ReviewerCounts>();
  const of = (id: string): ReviewerCounts => {
    let r = reviewers.get(id);
    if (!r) {
      r = {
        tasks: 0,
        failedTasks: 0,
        findings: { critical: 0, warning: 0, suggestion: 0 },
        costUsd: 0,
        fixed: 0,
        dismissed: 0,
      };
      reviewers.set(id, r);
    }
    return r;
  };
  for (const task of report.tasks) {
    const r = of(task.reviewer);
    r.tasks += 1;
    if (task.status === "failed" || task.status === "timed_out") r.failedTasks += 1;
    r.costUsd += task.usage.costUsd;
  }
  const verification = Object.fromEntries(verificationSchema.options.map((v) => [v, 0])) as Record<
    Verification,
    number
  >;
  const reviewerOf = new Map<string, string>();
  for (const finding of report.findings) {
    of(finding.reviewer).findings[finding.severity] += 1;
    verification[finding.verification ?? "unchecked"] += 1;
    if (!reviewerOf.has(finding.fingerprint)) reviewerOf.set(finding.fingerprint, finding.reviewer);
  }
  const outcomeReviewer = (f: { fingerprint: string; reviewer?: string }) =>
    f.reviewer ?? reviewerOf.get(f.fingerprint);
  const dismissed = new Map(
    (report.rereview?.dismissed ?? []).map((f) => [f.fingerprint, outcomeReviewer(f)]),
  );
  const fixed = new Map(
    (report.rereview?.fixed ?? [])
      .filter((f) => !dismissed.has(f.fingerprint))
      .map((f) => [f.fingerprint, outcomeReviewer(f)]),
  );
  for (const reviewer of fixed.values()) if (reviewer) of(reviewer).fixed += 1;
  for (const reviewer of dismissed.values()) if (reviewer) of(reviewer).dismissed += 1;
  return {
    reviewers: Object.fromEntries([...reviewers].sort(([a], [b]) => a.localeCompare(b))),
    verification,
    outcomes: { fixed: fixed.size, dismissed: dismissed.size },
  };
}

/** This machine's random salt, kept beside the credentials, made on first use. */
function machineSalt(credentialsPath: string): Promise<string> {
  return machineSecret(join(dirname(credentialsPath), "upload-salt"));
}

/**
 * The hash of a repository named as `https://host/owner/repo`
 * (repository-id.ts), salted with the account's salt when given, else this machine's.
 */
export async function repoHash(
  repository: string,
  credentialsPath: string,
  accountSalt?: string,
): Promise<string> {
  const salt = accountSalt ?? (await machineSalt(credentialsPath));
  return createHash("sha256").update(`${salt}:${repository}`).digest("hex");
}

/** Whether this run talks to ocra Cloud at all: signed in, not turned off. */
export async function cloudEnabled(
  deps: CloudDeps,
  warn: (message: string) => void,
): Promise<boolean> {
  return (
    deps.env.OCRA_CLOUD !== "off" &&
    (await readCredentials(deps.credentialsPath, warn)) !== undefined
  );
}

/**
 * Sends the counts, and the findings when given; answers how many findings
 * the server kept, or undefined when it took nothing. A failure is a
 * warning, never a failed review.
 */
export async function uploadReview(
  upload: ReviewUpload,
  deps: CloudDeps,
  warn: (message: string) => void,
  findings?: readonly SharedFinding[],
): Promise<{ findings: number } | undefined> {
  try {
    const answer = await new CloudClient(deps).uploadReview(
      // The counts stay in `findings`; the shared list goes in `findingList`.
      findings ? { ...upload, findingList: findings } : upload,
    );
    if (answer.kind === "signed-out") return undefined;
    if (answer.kind === "status") {
      warn(`ocra Cloud did not take the review's counts (HTTP ${answer.status})`);
      return undefined;
    }
    if (answer.kind !== "ok") {
      warn(`could not send the review's counts to ocra Cloud: ${sessionLostReason(answer)}`);
      return undefined;
    }
    return answer.value;
  } catch (error) {
    warn(`could not send the review's counts to ocra Cloud: ${failureName(error)}`);
    return undefined;
  }
}

// The warning names the error, not its message; for a call that could not be
// sent, the cause's name (TypeError for a network failure).
function failureName(error: unknown): string {
  const cause = error instanceof CloudError && error.cause instanceof Error ? error.cause : error;
  return cause instanceof Error ? cause.name : "error";
}
