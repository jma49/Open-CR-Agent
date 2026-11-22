import type { CodeMatch } from "./contracts.js";
import type { ChangeRequest, FileDiff, PriorReview } from "./domain.js";
import type { ReviewReport } from "./report/report.js";
import type { LinkedTask } from "./task/linked-task.js";

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
  // The tasks the platform links to the change, in its order (ADR-0052).
  // Absent: the adapter cannot tell.
  linkedTasks?(): Promise<LinkedTask[]>;
}
