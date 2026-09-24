import type { AnchorMethod, FileDiff, LineRange, ReportedFinding } from "../domain.js";
import { errorMessage } from "../errors.js";
import { isWithinHunks, matchInContent, matchInHunks } from "./match.js";

export interface Anchor {
  file: string;
  method: AnchorMethod;
  lineRange?: LineRange;
  inDiff: boolean;
  warning?: string;
}

export interface RelocationRequest {
  file: string;
  snippet: string;
  body: string;
  patch: string;
}

export interface AnchorContext {
  diffs: readonly FileDiff[];
  readNewFile(path: string): Promise<string | undefined>;
  relocate?(request: RelocationRequest): Promise<string | undefined>;
}

type AnchorInput = Pick<ReportedFinding, "file" | "existingCode" | "body">;

export async function anchorFinding(finding: AnchorInput, ctx: AnchorContext): Promise<Anchor> {
  const own = ctx.diffs.find((d) => d.newPath === finding.file);

  if (own) {
    const found = await locateInFile(own, finding.existingCode, ctx, "hunk", "file");
    if (found) return found;
  }

  for (const other of ctx.diffs) {
    if (other === own) continue;
    const lineRange = matchInHunks(other, finding.existingCode);
    if (lineRange) return { file: other.newPath, method: "cross_file", lineRange, inDiff: true };
  }

  if (own && ctx.relocate) {
    let snippet: string | undefined;
    try {
      snippet = await ctx.relocate({
        file: own.newPath,
        snippet: finding.existingCode,
        body: finding.body,
        patch: own.patch,
      });
    } catch (error) {
      return fileLevel(finding.file, `relocation failed: ${errorMessage(error)}`);
    }
    const found = snippet && (await locateInFile(own, snippet, ctx, "relocated", "relocated"));
    if (found) return found;
  }

  return fileLevel(finding.file);
}

async function locateInFile(
  diff: FileDiff,
  snippet: string,
  ctx: AnchorContext,
  hunkMethod: AnchorMethod,
  fileMethod: AnchorMethod,
): Promise<Anchor | undefined> {
  const inHunk = matchInHunks(diff, snippet);
  if (inHunk) return { file: diff.newPath, method: hunkMethod, lineRange: inHunk, inDiff: true };

  const content = await ctx.readNewFile(diff.newPath);
  const inFile = content === undefined ? undefined : matchInContent(content, snippet);
  if (!inFile) return undefined;
  return {
    file: diff.newPath,
    method: fileMethod,
    lineRange: inFile,
    inDiff: isWithinHunks(diff, inFile),
  };
}

function fileLevel(file: string, warning?: string): Anchor {
  return warning === undefined
    ? { file, method: "file_level", inDiff: false }
    : { file, method: "file_level", inDiff: false, warning };
}
