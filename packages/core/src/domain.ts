import { z } from "zod";

export const severitySchema = z.enum(["critical", "warning", "suggestion"]);
export type Severity = z.infer<typeof severitySchema>;

export const findingStatusSchema = z.enum(["new", "unfixed", "fixed", "dismissed"]);
export type FindingStatus = z.infer<typeof findingStatusSchema>;

export const lineRangeSchema = z.object({
  start: z.number().int().positive(),
  end: z.number().int().positive(),
});
export type LineRange = z.infer<typeof lineRangeSchema>;

export const reportedFindingSchema = z.object({
  category: z.string().min(1),
  severity: severitySchema,
  file: z.string().min(1),
  existingCode: z.string().min(1),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
  evidence: z.array(z.string()).default([]),
});
export type ReportedFinding = z.infer<typeof reportedFindingSchema>;

export type AnchorMethod = "hunk" | "file" | "cross_file" | "relocated" | "file_level";

// Normalized line count and hash of the code a finding is anchored to, so a
// later review can tell whether that code still exists without storing it.
export interface QuoteSignature {
  lines: number;
  hash: string;
}

export interface Finding extends ReportedFinding {
  id: string;
  fingerprint: string;
  reviewer: string;
  lineRange?: LineRange;
  anchor: { method: AnchorMethod; inDiff: boolean };
  status: FindingStatus;
  // --ultra keeps findings the judge would drop and marks them instead.
  lowConfidence?: boolean;
  // Absent when the finding is not anchored to lines.
  quote?: QuoteSignature;
}

export type FileChangeKind = "added" | "modified" | "deleted" | "renamed";

export type DiffLine =
  | { kind: "context"; content: string; oldLine: number; newLine: number }
  | { kind: "add"; content: string; newLine: number }
  | { kind: "delete"; content: string; oldLine: number };

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  kind: FileChangeKind;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: Hunk[];
  patch: string;
}

export interface ChangeRequest {
  id: string;
  title: string;
  description: string;
  baseSha: string;
  headSha: string;
}

export type RiskTier = "trivial" | "lite" | "full";

export type Verdict =
  | "approved"
  | "approved_with_comments"
  | "minor_issues"
  | "significant_concerns";

// What a platform remembers of an earlier review of the same change.
export interface PriorFinding {
  fingerprint: string;
  title: string;
  file: string;
  severity: Severity;
  // Whether the platform already shows it as an inline comment.
  commented: boolean;
  // A person resolved or declined it ("won't fix"); it stays quiet unless it gets worse.
  dismissed?: boolean;
  // Absent for findings without anchored lines and in state written before
  // it existed; such findings are never judged fixed by their code alone.
  quote?: QuoteSignature;
}

export interface PriorReview {
  findings: PriorFinding[];
}
