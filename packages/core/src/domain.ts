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

export interface Finding extends ReportedFinding {
  id: string;
  fingerprint: string;
  reviewer: string;
  lineRange?: LineRange;
  status: FindingStatus;
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

export interface ReviewResult {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}

export interface PriorReview {
  findings: Finding[];
}
