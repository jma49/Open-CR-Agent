import type { CodeMatch } from "./contracts.js";
import type { ChangeRequest, FileDiff, PriorReview } from "./domain.js";
import type { ReviewReport } from "./report/report.js";

// A comment that asks ocra something (ADR-0048), by its id on the platform;
// `inline` names a comment on a line of the diff where the platform keeps
// those apart (GitHub).
export interface MentionRef {
  id: string;
  inline?: boolean;
}

export type Mention =
  | {
      asked: true;
      by: string;
      question: string;
      // The thread's earlier comments, oldest first.
      thread: readonly { author: string; body: string }[];
      // The lines the comment is on, for a comment on the diff.
      on?: { path: string; line?: number };
      answer(text: string): Promise<void>;
    }
  // Not a question ocra answers, and why: no mention, someone without write
  // access, an edited comment, or one already answered.
  | { asked: false; reason: string };

// One commit ocra writes on the change request's own branch (ADR-0051).
export interface ChangeCommit {
  // The head the files were made from: the commit's only parent.
  parent: string;
  message: string;
  // Each file's whole new content, a regular file; `created`: no file is at
  // its path in the parent.
  files: readonly { path: string; content: string; created: boolean; executable: boolean }[];
}

export type CommitResult =
  | { committed: true; sha: string }
  // Nothing was written, and why: the branch moved past the parent, or the
  // token cannot write to it (a fork, a protected branch, a read-only token).
  | { committed: false; outcome: "head_moved" | "not_writable"; reason: string };

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
  // Absent: the adapter takes no questions.
  mention?(ref: MentionRef): Promise<Mention>;
  // The files directly in a directory of the reviewed revision, as readFile
  // takes their paths. Absent: the adapter cannot list them.
  listFiles?(dir: string): Promise<string[]>;
  // Absent: the adapter cannot commit to the change request.
  commit?(commit: ChangeCommit): Promise<CommitResult>;
}
