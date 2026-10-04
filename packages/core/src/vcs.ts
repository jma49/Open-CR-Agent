import type { CodeMatch } from "./contracts.js";
import type { ChangeRequest, FileDiff, PriorReview } from "./domain.js";
import type { ReviewReport } from "./report/report.js";

export interface VcsAdapter {
  readonly name: string;
  getChangeRequest(): Promise<ChangeRequest>;
  getDiff(): Promise<FileDiff[]>;
  // Content as git stores it: never follows a symbolic link, which reads as
  // its target path, so the access policy on the requested name holds.
  readFile(path: string): Promise<string | undefined>;
  searchCode(literal: string): Promise<CodeMatch[]>;
  getPriorReview(): Promise<PriorReview | undefined>;
  // Warnings describe parts that could not be published; the rest was.
  publish(report: ReviewReport): Promise<{ warnings: string[] }>;
}
