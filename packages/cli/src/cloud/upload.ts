import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ReviewSource, ReviewUpload, SharedFinding } from "@open-cr-agent/cloud-contract";
import { coverageGaps, isIncompleteReview, type ReviewReport } from "@open-cr-agent/core";
import { machineSecret } from "../io/private-file.js";
import { reviewerOutcomes } from "../reviewer-outcomes.js";
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
    complete: !isIncompleteReview(report),
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

// Counted as `ocra metrics` counts reports (reviewer-outcomes.ts).
function perReviewer(
  report: ReviewReport,
): Required<Pick<ReviewUpload, "reviewers" | "verification" | "outcomes">> {
  const { reviewers, verification, fixed, dismissed } = reviewerOutcomes([report]);
  return { reviewers, verification, outcomes: { fixed, dismissed } };
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
