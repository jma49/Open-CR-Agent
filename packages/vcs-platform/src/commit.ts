import { posix } from "node:path";
import type { ChangeCommit, CommitResult } from "@open-cr-agent/core";
import { OcraError } from "@open-cr-agent/core";
import type { PlatformChangeRequest, ReviewPlatform } from "./platform.js";

// What holds for a commit of ocra's on every platform (ADR-0051): it is made
// from the head ocra read, it names each file once by a plain path inside
// the repository, and the platform never forces the branch. The platform
// writes it and tells a moved branch or a refusal apart.
export async function commitToChangeRequest(
  platform: Pick<ReviewPlatform, "commit">,
  read: PlatformChangeRequest,
  commit: ChangeCommit,
): Promise<CommitResult> {
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
  return platform.commit(commit);
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
