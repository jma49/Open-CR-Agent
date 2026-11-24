import type { ReviewSource, ReviewUpload } from "@open-cr-agent/cloud-contract";
import { errorMessage, type MemoryEntry, type ReviewReport } from "@open-cr-agent/core";
import type { Output } from "../io/output.js";
import { MachineSecretError } from "../io/private-file.js";
import { originRepository } from "../repository-id.js";
import { readAccountSalt, saveAccountSalt } from "./account-salt.js";
import { CloudClient, type CloudSessionLost, sessionLostReason } from "./client.js";
import type { CloudDeps } from "./deps.js";
import { type SharedFindings, sharedFindings, sharedOutcomes } from "./findings.js";
import { sharedLinkedTasks } from "./linked-tasks.js";
import { accountHasMemory, fetchAccountMemory } from "./memory.js";
import { sharedMergeChecks } from "./merge-checks.js";
import { sharedRepo } from "./repo-name.js";
import { sharedRuleTexts } from "./rule-texts.js";
import { hasSharingConsent, saveSharingConsent } from "./sharing-consent.js";
import { sharedTrace } from "./trace.js";
import { repoHash, uploadOf, uploadReview } from "./upload.js";
import { sharedWalkthrough } from "./walkthrough.js";

// What a signed-in review takes from ocra Cloud before it runs (ADR-0028):
// the repository's hash, whether to share findings, and the findings the
// account remembers for the repository.

export type CloudReview = {
  // The repository as hashed: `https://host/owner/repo` (repository-id.ts).
  repository: string;
  repoHash: string;
  // The account answered a salt, the server's signal that it shares
  // findings, and this machine agreed to send them (sharing-consent.ts).
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
 * Undefined when the saved session is gone or no salt can be had (this
 * machine's cannot be read or made); a failure to reach ocra Cloud is one
 * warning. The repository is the pull or merge request's when given, else
 * origin's.
 */
export async function prepareCloudReview(
  root: string,
  deps: CloudDeps,
  warn: (message: string) => void,
  repository?: string,
): Promise<CloudReview | undefined> {
  try {
    return await prepare(root, deps, warn, repository);
  } catch (error) {
    // A hash under another salt would count the repository as a new one.
    if (!(error instanceof MachineSecretError)) throw error;
    warn(`${error.message}; this review sends nothing to ocra Cloud`);
    return undefined;
  }
}

async function prepare(
  root: string,
  deps: CloudDeps,
  warn: (message: string) => void,
  repository: string | undefined,
): Promise<CloudReview | undefined> {
  const id = repository ?? (await originRepository(root));
  let salt: string | null;
  try {
    const answer = await new CloudClient(deps).accountSalt();
    if (answer.kind === "signed-out") return undefined;
    if (answer.kind === "status") throw new Error(`HTTP ${answer.status}`);
    if (answer.kind === "malformed") throw new Error("the answer is not a salt");
    if (answer.kind !== "ok") throw new Error(sessionLostReason(answer));
    salt = answer.value;
  } catch (error) {
    // The salt kept from the last answer, else this machine's, still groups
    // the counts. Whether the account still shares findings is unknown, so
    // none is sent and the account's memory is not applied. Hashed before
    // the warning: without a salt this review sends nothing, said once.
    const kept = await readAccountSalt(deps.credentialsPath);
    const hash = await repoHash(id, deps.credentialsPath, kept);
    warn(
      `could not read your ocra Cloud account (${errorMessage(error)}); this review sends no findings and applies no account memory`,
    );
    return { repository: id, repoHash: hash, shareFindings: false, memory: [] };
  }
  await keepAccountSalt(deps.credentialsPath, salt, warn);
  const hash = await repoHash(id, deps.credentialsPath, salt ?? undefined);
  if (salt === null) {
    await forgetSharingConsent(deps.credentialsPath, warn);
    // Memory is keyed by the account's hash, which only a sharing account has.
    if (await accountHasMemory(deps)) {
      warn(
        "your ocra Cloud account remembers findings, but applies them only while it shares findings (Settings in ocra Cloud); this review applies the repository's memory alone",
      );
    }
    return { repository: id, repoHash: hash, shareFindings: false, memory: [] };
  }
  const consented = await hasSharingConsent(deps.credentialsPath);
  if (!consented) {
    warn(
      "your ocra Cloud account shares findings, but this machine has not agreed to send them since it signed in; this review sends counts only (run ocra login to send findings from this machine)",
    );
  }
  return {
    repository: id,
    repoHash: hash,
    shareFindings: consented,
    memory: await fetchAccountMemory(deps, hash, warn),
  };
}

// Sharing is off: a later switch back on is not this machine's consent.
async function forgetSharingConsent(
  credentialsPath: string,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await saveSharingConsent(credentialsPath, false);
  } catch (error) {
    warn(
      `could not remove this machine's consent to send findings (${errorMessage(error)}); if your ocra Cloud account shares findings again, this machine sends them without a new ocra login`,
    );
  }
}

// A copy for the reviews that cannot reach ocra Cloud; without it this
// review still has the answer's salt, so only those hash differently.
async function keepAccountSalt(
  credentialsPath: string,
  salt: string | null,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await saveAccountSalt(credentialsPath, salt);
  } catch (error) {
    warn(
      salt === null
        ? `could not remove the ocra Cloud account salt this machine kept (${errorMessage(error)}); a review that cannot reach ocra Cloud may still hash this repository with it`
        : `could not keep your ocra Cloud account's salt (${errorMessage(error)}); a review that cannot reach ocra Cloud may count this repository as another`,
    );
  }
}

/** What a review sends: the counts, and what goes with a change request or the findings. */
export function cloudUpload(
  report: ReviewReport,
  cloud: Pick<CloudReview, "repository" | "repoHash" | "shareFindings">,
  run: {
    source: ReviewSource;
    durationMs: number;
    changeRequestNumber?: number;
    shareRepoName?: boolean;
  },
): { upload: ReviewUpload; shared?: SharedFindings } {
  const number = run.changeRequestNumber;
  const changeRequest = number === undefined ? undefined : { repository: cloud.repository, number };
  const counts = uploadOf(report, run.source, cloud.repoHash, run.durationMs, changeRequest);
  const walkthrough =
    cloud.shareFindings && report.walkthrough ? sharedWalkthrough(report.walkthrough) : undefined;
  const linkedTasks =
    changeRequest && report.linkedTasks
      ? sharedLinkedTasks(report.linkedTasks, cloud.shareFindings)
      : undefined;
  // Which learnings applied is named like the files, so with a pull or
  // merge request's identity (ADR-0038) or with the findings.
  const learnings =
    changeRequest || cloud.shareFindings ? (report.learnings ?? []).map((l) => l.id) : undefined;
  const mergeChecks =
    changeRequest && report.mergeChecks
      ? sharedMergeChecks(report.mergeChecks, cloud.shareFindings)
      : undefined;
  // Which earlier findings were fixed or dismissed is named like the findings.
  const outcomes =
    cloud.shareFindings && counts.outcomes
      ? { outcomes: { ...counts.outcomes, ...sharedOutcomes(report) } }
      : {};
  // The trace names files, findings and why each was dropped, like the findings.
  const trace = cloud.shareFindings && report.trace ? sharedTrace(report.trace) : undefined;
  const shared = cloud.shareFindings ? sharedFindings(report) : undefined;
  const provenance = shared && sharedRuleTexts(report, shared.findings);
  const repo = run.shareRepoName ? sharedRepo(cloud.repository) : undefined;
  const upload = {
    ...counts,
    ...(repo ? { repo } : {}),
    ...outcomes,
    ...(walkthrough ? { walkthrough } : {}),
    ...(linkedTasks ? { linkedTasks } : {}),
    ...(learnings ? { learnings } : {}),
    ...(mergeChecks ? { mergeChecks } : {}),
    ...(trace ? { trace } : {}),
    ...(provenance ? { provenance } : {}),
  };
  return shared ? { upload, shared } : { upload };
}

/** Sends the counts, and the findings when the account shares them. */
export async function sendToCloud(
  report: ReviewReport,
  cloud: CloudReview,
  deps: CloudDeps,
  run: {
    source: ReviewSource;
    durationMs: number;
    changeRequestNumber?: number;
    shareRepoName?: boolean;
    err: Output;
    warn: (message: string) => void;
  },
): Promise<void> {
  const { upload, shared } = cloudUpload(report, cloud, run);
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
