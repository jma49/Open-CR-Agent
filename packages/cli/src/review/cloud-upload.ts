import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  coverageGaps,
  type ReviewReport,
  type Severity,
  type Verification,
} from "@open-cr-agent/core";
import { verificationSchema } from "@open-cr-agent/core/internal";
import { type CloudDeps, cloudSession, readCredentials } from "../cloud.js";
import { VERSION } from "../version.js";
import type { SharedFinding } from "./cloud-findings.js";

// After a review, a signed-in CLI sends ocra Cloud its counts (ADR-0024):
// the verdict, how many findings of each severity, files and tasks, tokens
// and time. A path, a title, a finding's text or code go only when the
// account shares findings (ADR-0028, cloud-findings.ts). The repository is
// a salted hash, so the server can group reviews of one repository without
// learning which it is: the salt stays on this machine, or is the account's
// while it shares findings, so the hash matches on all its machines.

const run = promisify(execFile);

export type ReviewSource = "local" | "github" | "gitlab";

export type ReviewerCounts = {
  tasks: number;
  failedTasks: number;
  findings: Record<Severity, number>;
  costUsd: number;
  fixed: number;
  dismissed: number;
};

export type ReviewUpload = {
  runId: string;
  repoHash: string;
  source: ReviewSource;
  tier: string;
  verdict: string;
  complete: boolean;
  findings: { critical: number; warning: number; suggestion: number };
  files: { reviewed: number; notReviewed: number };
  tasks: { completed: number; failed: number };
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  durationMs: number;
  ocraVersion: string;
  // Added by ADR-0028; optional so a server reading older uploads still can.
  reviewers?: Record<string, ReviewerCounts>;
  verification?: Record<Verification, number>;
  outcomes?: { fixed: number; dismissed: number };
};

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
    complete: gaps.notReviewed === 0,
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
      failed: report.tasks.filter((t) => t.status === "failed").length,
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
// a fix, and a fixed or dismissed finding is attributed to the reviewer of a
// finding with its fingerprint in this report, or to none.
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
  const dismissed = new Set((report.rereview?.dismissed ?? []).map((f) => f.fingerprint));
  const fixed = new Set(
    (report.rereview?.fixed ?? []).map((f) => f.fingerprint).filter((fp) => !dismissed.has(fp)),
  );
  for (const fp of fixed) {
    const reviewer = reviewerOf.get(fp);
    if (reviewer) of(reviewer).fixed += 1;
  }
  for (const fp of dismissed) {
    const reviewer = reviewerOf.get(fp);
    if (reviewer) of(reviewer).dismissed += 1;
  }
  return {
    reviewers: Object.fromEntries([...reviewers].sort(([a], [b]) => a.localeCompare(b))),
    verification,
    outcomes: { fixed: fixed.size, dismissed: dismissed.size },
  };
}

/** The repository's origin without credentials, or its root path when it has none. */
async function repositoryId(root: string): Promise<string> {
  try {
    const { stdout } = await run("git", ["-C", root, "remote", "get-url", "origin"], {
      timeout: 10_000,
    });
    const url = stdout.trim();
    return url
      .replace(/^[a-z+]+:\/\/[^@/]*@/i, (m) => m.slice(0, m.indexOf("//") + 2))
      .replace(/\.git$/, "")
      .toLowerCase();
  } catch {
    return root;
  }
}

/** This machine's random salt, kept beside the credentials, made on first use. */
async function machineSalt(credentialsPath: string): Promise<string> {
  const path = join(dirname(credentialsPath), "upload-salt");
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {}
  const fresh = randomBytes(32).toString("hex");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${fresh}\n`, { mode: 0o600 });
  return fresh;
}

/** The repository's hash, salted with the account's salt when given, else this machine's. */
export async function repoHash(
  root: string,
  credentialsPath: string,
  accountSalt?: string,
): Promise<string> {
  const salt = accountSalt ?? (await machineSalt(credentialsPath));
  return createHash("sha256")
    .update(`${salt}:${await repositoryId(root)}`)
    .digest("hex");
}

/** Whether this run talks to ocra Cloud at all: signed in, not turned off. */
export async function cloudEnabled(deps: CloudDeps): Promise<boolean> {
  return (
    deps.env.OCRA_CLOUD !== "off" && (await readCredentials(deps.credentialsPath)) !== undefined
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
    const session = await cloudSession(deps);
    if (!session) return undefined;
    const res = await deps.fetch(`${session.server}/api/reviews`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
        "user-agent": `ocra/${VERSION}`,
      },
      // The counts stay in `findings`; the shared list goes in `findingList`.
      body: JSON.stringify(findings ? { ...upload, findingList: findings } : upload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn(`ocra Cloud did not take the review's counts (HTTP ${res.status})`);
      return undefined;
    }
    const answer = (await res.json().catch(() => ({}))) as { findings?: unknown };
    const kept = answer.findings;
    return { findings: typeof kept === "number" && Number.isInteger(kept) && kept > 0 ? kept : 0 };
  } catch (error) {
    warn(
      `could not send the review's counts to ocra Cloud: ${error instanceof Error ? error.name : "error"}`,
    );
    return undefined;
  }
}
