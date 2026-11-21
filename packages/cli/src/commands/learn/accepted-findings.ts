import type { FileDiff } from "@open-cr-agent/core";
import { MEMORY_PATH, parseMemory } from "@open-cr-agent/core/internal";
import type { TrustedTree } from "../review/target.js";
import type { Candidate } from "./pipeline.js";

// More of a file than this says nothing more about one finding.
const MAX_FILE_CHARS = 8_000;

// Source 2 of ADR-0040, review feedback: the findings the team accepted in
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
          files: content === undefined ? [] : [unchanged(entry.file, content)],
        };
      },
    }));
}

// The file as the unchanged lines of a diff, so the draft's symbols are
// checked against it and the selection replays it like a change there.
function unchanged(path: string, content: string): FileDiff {
  const patch = content
    .slice(0, MAX_FILE_CHARS)
    .split("\n")
    .map((line) => ` ${line}`)
    .join("\n");
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
    patch,
  };
}
