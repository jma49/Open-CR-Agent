import type { ReferenceComment } from "./dataset.js";

export interface GeneratedComment {
  path: string;
  side: "left" | "right";
  fromLine: number | null;
  toLine: number | null;
  note: string;
}

export interface SemanticJudge {
  sameIssue(reference: string, generated: string): Promise<boolean>;
}

export interface ReferenceMatch {
  reference: ReferenceComment;
  lineMatch: boolean;
  semanticMatch: boolean;
  matchedIndex?: number;
}

export const LINE_TOLERANCE = 1;

// Port of AACR-Bench's evaluate_comments so results stay comparable with the
// published numbers: path, then side, then line proximity, then the judge.
// Each generated comment counts at most once per stage.
export async function matchComments(
  references: readonly ReferenceComment[],
  generated: readonly GeneratedComment[],
  judge: SemanticJudge,
): Promise<ReferenceMatch[]> {
  const usedByLine = new Set<number>();
  const usedBySemantic = new Set<number>();
  const results: ReferenceMatch[] = [];

  for (const reference of references) {
    const result: ReferenceMatch = { reference, lineMatch: false, semanticMatch: false };
    for (const [index, candidate] of generated.entries()) {
      if (!candidate.note.trim() || normalizePath(candidate.path) !== normalizePath(reference.path))
        continue;
      if (candidate.side !== reference.side) continue;
      if (!linesClose(reference, candidate)) continue;

      if (!result.lineMatch && !usedByLine.has(index)) {
        result.lineMatch = true;
        usedByLine.add(index);
      }
      if (usedBySemantic.has(index)) continue;
      if (await judge.sameIssue(reference.note, candidate.note)) {
        result.semanticMatch = true;
        result.matchedIndex = index;
        usedBySemantic.add(index);
        break;
      }
    }
    results.push(result);
  }
  return results;
}

// A missing range on either side skips the line stage, as in the reference
// implementation, so file-level comments are judged on content alone.
function linesClose(a: ReferenceComment, b: GeneratedComment): boolean {
  if (a.fromLine === null || a.toLine === null || b.fromLine === null || b.toLine === null)
    return true;
  if (a.fromLine <= b.toLine && b.fromLine <= a.toLine) return true;
  const distance = Math.min(Math.abs(a.fromLine - b.toLine), Math.abs(b.fromLine - a.toLine));
  return distance <= LINE_TOLERANCE;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
