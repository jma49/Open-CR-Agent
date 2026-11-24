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

// One commit ocra writes on the change request's own branch (ADR-0051).
export interface ChangeCommit {
  // The head the files were made from: the commit's first parent.
  parent: string;
  // Set for a merge of the base branch into the head: the base branch's
  // commit, the second parent. The commit's tree is then git's merge of the
  // two, with `files` in place of the files that conflicted.
  mergeParent?: string;
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

// A check that failed on the change request's head and does not fail under
// the same name on the base branch's head (ADR-0078 point 3). `log`: the end
// of its failed job's output, cut by logTail, or what the check reported of
// itself; empty when the platform gives neither.
export interface FailedCheck {
  name: string;
  log: string;
}

export interface ChangeChecks {
  // Some check of the head has not finished: more may fail yet.
  pending: boolean;
  // At most CHECK_LIMITS.checks of them, in the platform's order.
  failed: FailedCheck[];
}

// A file the change request and its base branch changed in the same lines,
// as git merged it: diff3 style, the change request's side first, with
// markers of `markerSize` characters, a size no line of the file starts
// with.
export interface ConflictedFile {
  path: string;
  merged: string;
  markerSize: number;
  executable: boolean;
}

// What stands between the change request's head and a merge of its base
// branch (ADR-0078 point 3).
export interface ChangeConflicts {
  // The base branch's head that was merged in.
  mergeParent: string;
  files: ConflictedFile[];
  // Conflicted paths that are not a text conflict of one regular file
  // (deleted or renamed on a side, binary, too large): a person's.
  other: string[];
}

// One item of a round of the fix loop as its note names it: a finding by
// its title and file, a failed check by its name.
export interface RoundNoteItem {
  title: string;
  file?: string;
  check?: boolean;
}

// What a round of the fix loop committed and what it left (ADR-0078 point
// 7), for the change request's readers. `outcome` and `reason` are the
// loop's own words (MEND_ITEM_OUTCOMES, MEND_ITEM_REASONS).
export interface RoundNote {
  commitSha: string;
  // The commit merges the base branch, so undoing it names the parent kept.
  merge?: boolean;
  fixed: RoundNoteItem[];
  left: (RoundNoteItem & { outcome: string; reason?: string })[];
}

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
  // Shows on the change request that a review of its head is running, until
  // publish or stopped says how it ended. Absent: nowhere to show it.
  started?(): Promise<{ warnings: string[] }>;
  stopped?(reason: string): Promise<{ warnings: string[] }>;
  // Absent: the adapter takes no questions.
  mention?(ref: MentionRef): Promise<Mention>;
  // The files directly in a directory of the reviewed revision, as readFile
  // takes their paths. Absent: the adapter cannot list them.
  listFiles?(dir: string): Promise<string[]>;
  // Absent: the adapter cannot commit to the change request.
  commit?(commit: ChangeCommit): Promise<CommitResult>;
  // The conflicts of merging the base branch's head into `headSha`;
  // undefined when they merge cleanly. Absent: the adapter cannot tell.
  conflicts?(headSha: string): Promise<ChangeConflicts | undefined>;
  // Says on the change request what a round of the fix loop committed.
  // Absent: the adapter has nowhere to say it.
  note?(round: RoundNote): Promise<void>;
  // The checks of the commit `headSha`, the change request's head as the
  // caller read it. Absent: the adapter cannot read them.
  checks?(headSha: string): Promise<ChangeChecks>;
  // The tasks the platform links to the change, in its order (ADR-0052).
  // Absent: the adapter cannot tell.
  linkedTasks?(): Promise<LinkedTask[]>;
}
