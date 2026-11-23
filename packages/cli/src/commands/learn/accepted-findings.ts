import type { VcsAdapter } from "@open-cr-agent/core";
import { MEMORY_PATH, parseMemory } from "@open-cr-agent/core/internal";
import type { TrustedTree } from "../review/target.js";
import { unchanged } from "./evidence.js";
import type { Candidate } from "./pipeline.js";

// More of a file than this says nothing more about one finding.
const MAX_FILE_CHARS = 8_000;

// The review-feedback source of ADR-0040: the findings the team accepted in
// .ocra/memory.json with the reason they gave, read from the trusted
// revision, newest first. A dismissal without a reason holds no lesson.
export async function acceptedFindingCandidates(tree: TrustedTree): Promise<Candidate[]> {
  const text = await tree.readFile(MEMORY_PATH);
  if (text === undefined) return [];
  return parseMemory(text)
    .toReversed()
    .map((entry) => ({
      ref: entry.fingerprint,
      evidence: async () => {
        const content = await tree.readFile(entry.file);
        return {
          kind: "accepted-finding",
          source: { kind: "review-feedback", ref: entry.fingerprint },
          subject: entry.title,
          message: entry.reason,
          files: content === undefined ? [] : [unchanged(entry.file, content, MAX_FILE_CHARS)],
        };
      },
    }));
}

// The same source on a pull or merge request (ADR-0069): the findings
// someone with write access declined in their thread, with what they said,
// and the file as the change has it, else as the trusted revision does.
export async function declinedFindingCandidates(
  vcs: VcsAdapter,
  tree: TrustedTree,
): Promise<Candidate[]> {
  const declined = (await vcs.getChangeRequest()).declined ?? [];
  if (declined.length === 0) return [];
  const diff = (await vcs.getDiff()).filter((f) => !f.isBinary);
  return declined.map((d) => ({
    ref: d.fingerprint,
    evidence: async () => {
      const changed = diff.find((f) => f.newPath === d.file);
      const content = changed ? undefined : await tree.readFile(d.file);
      return {
        kind: "accepted-finding",
        source: { kind: "review-feedback", ref: d.fingerprint },
        subject: d.title,
        message: d.reason,
        files: changed
          ? [changed]
          : content === undefined
            ? []
            : [unchanged(d.file, content, MAX_FILE_CHARS)],
      };
    },
  }));
}
