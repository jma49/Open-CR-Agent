import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { coverageGaps, type ReviewReport } from "@open-cr-agent/core";
import { type CloudDeps, cloudSession, readCredentials } from "../cloud.js";
import { VERSION } from "../version.js";

// After a review, a signed-in CLI sends ocra Cloud its counts (ADR-0024):
// the verdict, how many findings of each severity, files and tasks, tokens
// and time. Never a path, a title, a finding's text or code. The repository
// is a hash salted with a value that stays on this machine, so the server
// can group reviews of one repository without learning which it is.

const run = promisify(execFile);

export type ReviewSource = "local" | "github" | "gitlab";

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

/** A random salt kept beside the credentials, made on first use. */
async function salt(credentialsPath: string): Promise<string> {
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

export async function repoHash(root: string, credentialsPath: string): Promise<string> {
  return createHash("sha256")
    .update(`${await salt(credentialsPath)}:${await repositoryId(root)}`)
    .digest("hex");
}

/** Whether this run talks to ocra Cloud at all: signed in, not turned off. */
export async function cloudEnabled(deps: CloudDeps): Promise<boolean> {
  return (
    deps.env.OCRA_CLOUD !== "off" && (await readCredentials(deps.credentialsPath)) !== undefined
  );
}

/** Sends the counts; a failure is a warning, never a failed review. */
export async function uploadReview(
  upload: ReviewUpload,
  deps: CloudDeps,
  warn: (message: string) => void,
): Promise<boolean> {
  try {
    const session = await cloudSession(deps);
    if (!session) return false;
    const res = await deps.fetch(`${session.server}/api/reviews`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.access_token}`,
        "user-agent": `ocra/${VERSION}`,
      },
      body: JSON.stringify(upload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn(`ocra Cloud did not take the review's counts (HTTP ${res.status})`);
      return false;
    }
    return true;
  } catch (error) {
    warn(
      `could not send the review's counts to ocra Cloud: ${error instanceof Error ? error.name : "error"}`,
    );
    return false;
  }
}
