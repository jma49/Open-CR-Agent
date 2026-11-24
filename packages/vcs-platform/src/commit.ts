import { posix } from "node:path";
import type { ChangeCommit, CommitResult } from "@open-cr-agent/core";
import { OcraError } from "@open-cr-agent/core";
import type { PlatformChangeRequest, ReviewPlatform } from "./platform.js";
import type { MergeSource } from "./review.js";

// What holds for a commit of ocra's on every platform (ADR-0051): it is made
// from the head ocra read, it names each file once by a plain path inside
// the repository, and the platform never forces the branch. The platform
// writes it and tells a moved branch or a refusal apart.
export async function commitToChangeRequest(
  platform: Pick<ReviewPlatform, "commit">,
  read: PlatformChangeRequest,
  commit: ChangeCommit,
): Promise<CommitResult> {
  return refusedBefore(read, commit) ?? platform.commit(commit);
}

// A merge of the base branch into the head (ADR-0078 point 7) holds to the
// same rules and is made in the local clone, which pushes it without force:
// the remote takes it only while the branch is at the head ocra read.
export async function mergeToChangeRequest(
  platform: Pick<ReviewPlatform, "pushTarget">,
  merge: MergeSource | undefined,
  read: PlatformChangeRequest,
  commit: ChangeCommit,
): Promise<CommitResult> {
  const refused = refusedBefore(read, commit);
  if (refused) return refused;
  const notWritable = (reason: string): CommitResult => ({
    committed: false,
    outcome: "not_writable",
    reason,
  });
  if (!merge || commit.mergeParent === undefined) {
    return notWritable("there is no local clone to make the merge in");
  }
  const target = await platform.pushTarget();
  if ("refused" in target) return notWritable(target.refused);
  return merge.push({
    ours: commit.parent,
    theirs: commit.mergeParent,
    message: commit.message,
    files: commit.files.map(({ path, content }) => ({ path, content })),
    ...target,
  });
}

function refusedBefore(
  read: PlatformChangeRequest,
  commit: ChangeCommit,
): CommitResult | undefined {
  if (commit.parent !== read.headSha) {
    return {
      committed: false,
      outcome: "head_moved",
      reason: "the edits were not made from the head ocra read",
    };
  }
  if (commit.files.length === 0) throw new OcraError("CONFIG_INVALID", "the commit has no files");
  const paths = new Set<string>();
  for (const { path } of commit.files) {
    if (!isPlainPath(path) || paths.has(path.toLowerCase())) {
      throw new OcraError("ACCESS_DENIED", `ocra does not commit to ${JSON.stringify(path)}`);
    }
    paths.add(path.toLowerCase());
  }
  return undefined;
}

// Compared after normalising, so no spelling of a path reaches outside the
// repository or into .git.
function isPlainPath(path: string): boolean {
  if (path.includes("\\") || /[\p{Cc}]/u.test(path)) return false;
  const normalized = posix.normalize(path);
  if (normalized !== path || normalized.startsWith("/")) return false;
  return normalized
    .split("/")
    .every((s) => s !== "" && s !== "." && s !== ".." && s.toLowerCase() !== ".git");
}
