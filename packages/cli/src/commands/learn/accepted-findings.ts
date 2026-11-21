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
