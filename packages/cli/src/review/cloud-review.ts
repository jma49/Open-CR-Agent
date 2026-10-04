import type { MemoryEntry, ReviewReport } from "@open-cr-agent/core";
import { fetchAccountSalt, saveAccountSalt } from "../account-salt.js";
import { type CloudDeps, type Credentials, cloudSession } from "../cloud.js";
import { sharedFindings } from "./cloud-findings.js";
import { fetchAccountMemory } from "./cloud-memory.js";
import { type ReviewSource, repoHash, uploadOf, uploadReview } from "./cloud-upload.js";
import type { Output } from "./progress.js";

// What a signed-in review takes from ocra Cloud before it runs (ADR-0028):
// the repository's hash, whether the account shares findings, and the
// findings the account remembers for the repository.

export type CloudReview = {
  repoHash: string;
  // The account answered a salt: the server's signal that it shares findings.
  shareFindings: boolean;
  memory: MemoryEntry[];
};

/** Undefined when the saved session is gone; a failure to reach ocra Cloud is one warning. */
export async function prepareCloudReview(
  root: string,
  deps: CloudDeps,
  warn: (message: string) => void,
): Promise<CloudReview | undefined> {
  let session: Credentials | undefined;
  let salt: string | null;
  try {
    session = await cloudSession(deps);
    if (!session) return undefined;
    salt = await fetchAccountSalt(deps, session.server, session.access_token);
  } catch (error) {
    // This machine's salt still groups the counts. Findings and the
    // account's memory are keyed by the account's hash when it shares
    // findings, so without its answer neither can be matched: none is sent
    // and none applied.
    warn(
      `could not read your ocra Cloud account (${error instanceof Error ? error.message : "error"}); this review sends no findings and applies no account memory`,
    );
    return {
      repoHash: await repoHash(root, deps.credentialsPath),
      shareFindings: false,
      memory: [],
    };
  }
  await saveAccountSalt(deps.credentialsPath, salt);
  const hash = await repoHash(root, deps.credentialsPath, salt ?? undefined);
  return {
    repoHash: hash,
    shareFindings: salt !== null,
    memory: await fetchAccountMemory(deps, session, hash, warn),
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
