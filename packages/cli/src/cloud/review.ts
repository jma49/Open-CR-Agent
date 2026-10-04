import type { MemoryEntry, ReviewReport } from "@open-cr-agent/core";
import type { Output } from "../io/output.js";
import { originRepository } from "../review/repository-id.js";
import { accountSaltOf, readAccountSalt, saveAccountSalt } from "./account-salt.js";
import type { CloudDeps } from "./deps.js";
import { sharedFindings } from "./findings.js";
import { accountHasMemory, fetchAccountMemory } from "./memory.js";
import { type CloudSessionLost, cloudFetch, sessionLostReason } from "./session.js";
import { type ReviewSource, repoHash, uploadOf, uploadReview } from "./upload.js";

// What a signed-in review takes from ocra Cloud before it runs (ADR-0028):
// the repository's hash, whether the account shares findings, and the
// findings the account remembers for the repository.

export type CloudReview = {
  repoHash: string;
  // The account answered a salt: the server's signal that it shares findings.
  shareFindings: boolean;
  memory: MemoryEntry[];
};

/** What a review loses when ocra Cloud cannot be used for it, said once. */
export function sessionLostWarning(
  lost: Exclude<CloudSessionLost, { kind: "signed-out" }>,
): string {
  const cause =
    lost.kind === "revoked"
      ? sessionLostReason(lost)
      : `could not reach ocra Cloud (${lost.reason})`;
  return `${cause}; this review runs without your account's rules, limits (maxCostUsd included), models and memory, and uploads nothing`;
}

/**
 * Undefined when the saved session is gone; a failure to reach ocra Cloud is
 * one warning. The repository is the pull or merge request's when given,
 * else origin's.
 */
export async function prepareCloudReview(
  root: string,
  deps: CloudDeps,
  warn: (message: string) => void,
  repository?: string,
): Promise<CloudReview | undefined> {
  const id = repository ?? (await originRepository(root));
  let salt: string | null;
  try {
    const answer = await cloudFetch(deps, "/api/account/salt");
    if (answer.kind === "signed-out") return undefined;
    if (answer.kind !== "answered") throw new Error(sessionLostReason(answer));
    salt = await accountSaltOf(answer.res);
  } catch (error) {
    // The salt kept from the last answer, else this machine's, still groups
    // the counts. Whether the account still shares findings is unknown, so
    // none is sent and the account's memory is not applied.
    warn(
      `could not read your ocra Cloud account (${error instanceof Error ? error.message : "error"}); this review sends no findings and applies no account memory`,
    );
    const kept = await readAccountSalt(deps.credentialsPath);
    return {
      repoHash: await repoHash(id, deps.credentialsPath, kept),
      shareFindings: false,
      memory: [],
    };
  }
  await saveAccountSalt(deps.credentialsPath, salt);
  const hash = await repoHash(id, deps.credentialsPath, salt ?? undefined);
  if (salt === null) {
    // Memory is keyed by the account's hash, which only a sharing account has.
    if (await accountHasMemory(deps)) {
      warn(
        "your ocra Cloud account remembers findings, but applies them only while it shares findings (Settings in ocra Cloud); this review applies the repository's memory alone",
      );
    }
    return { repoHash: hash, shareFindings: false, memory: [] };
  }
  return {
    repoHash: hash,
    shareFindings: true,
    memory: await fetchAccountMemory(deps, hash, warn),
  };
}

/** Sends the counts, and the findings when the account shares them. */
export async function sendToCloud(
  report: ReviewReport,
  cloud: CloudReview,
  deps: CloudDeps,
  run: {
    source: ReviewSource;
    durationMs: number;
    err: Output;
    warn: (message: string) => void;
  },
): Promise<void> {
  const upload = uploadOf(report, run.source, cloud.repoHash, run.durationMs);
  const shared = cloud.shareFindings ? sharedFindings(report) : undefined;
  const sent = await uploadReview(upload, deps, run.warn, shared?.findings);
  if (!sent) return;
  if (sent.findings > 0) {
    const left = shared?.left ? ` (${shared.left} left out by the size limit)` : "";
    run.err.write(
      `[ocra] Sent this review's counts and ${sent.findings} finding(s) to ocra Cloud${left} (--no-upload to skip)\n`,
    );
  } else {
    run.err.write("[ocra] Sent this review's counts to ocra Cloud (--no-upload to skip)\n");
  }
}
