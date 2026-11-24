import type {
  ChangeCommit,
  CommitResult,
  Finding,
  LinkedTask,
  MentionRef,
  ReviewReport,
} from "@open-cr-agent/core";
import type { PlatformText } from "./render.js";
import type { SuggestionFence } from "./suggestion.js";

// What ocra needs from a code review platform (GitHub, GitLab) to hold a
// review conversation: the change request, its comments and threads, who may
// act on them, and where to post. Which comments count, what dismisses a
// finding and what the summary says are the same everywhere and live in
// PlatformReview, so a platform adapter maps its API and nothing more.
export interface ReviewPlatform {
  readonly text: PlatformText;
  // How the platform spells a committable suggestion of commented lines.
  readonly suggestionFence: SuggestionFence;
  // The account ocra posts as.
  bot(): Promise<Bot>;
  changeRequest(): Promise<PlatformChangeRequest>;
  // Comments on the change request as a whole (not on lines), oldest first.
  comments(): Promise<PlatformComment[]>;
  // Who last edited a comment, or undefined when nobody did since it was
  // posted. Throws when that cannot be told.
  editor(comment: PlatformComment): Promise<string | undefined>;
  // Whether someone may change the code: write access on GitHub, the
  // Developer role or higher on GitLab.
  canWrite(login: string): Promise<boolean>;
  threads(): Promise<PlatformThread[]>;
  // Issues of the reviewed repository the change request closes, in the
  // platform's order, or the one its head branch is named after (ADR-0052).
  linkedTasks(): Promise<LinkedTask[]>;
  // Posts inline comments for findings on lines of the diff; findings the
  // platform will not place stay in the summary.
  publishFindings(
    report: ReviewReport,
    fresh: readonly InlineFinding[],
  ): Promise<PublishedFindings>;
  writeSummary(existing: PlatformComment | undefined, body: string): Promise<void>;
  resolveThread(id: string): Promise<void>;
  // The comment and the conversation it is in; undefined when it is not on
  // this change request. Throws when who edited it cannot be told.
  discussion(ref: MentionRef): Promise<PlatformDiscussion | undefined>;
  // Answers in the comment's thread, or after it on the change request when
  // the platform keeps no thread for it.
  reply(discussion: PlatformDiscussion, body: string): Promise<void>;
  // Writes the commit on the change request's source branch only while its
  // head is the commit's parent, as the token's own account; a moved branch
  // or a branch the token may not write to (a fork's) is an outcome, not an
  // error.
  commit(commit: ChangeCommit): Promise<CommitResult>;
  // The head of the branch the change request merges into, as it is now.
  baseHead(): Promise<string>;
  // The change request's source branch and who ocra's commits are by, for
  // a commit pushed from the local clone; `refused` when the token's
  // account may not write to it (a fork's branch, a protected one).
  pushTarget(): Promise<
    { branch: string; author: { name: string; email: string } } | { refused: string }
  >;
  // The checks the platform ran on a commit, each under its latest run.
  checks(sha: string): Promise<PlatformCheck[]>;
  // The names of the checks that fail on the head of the branch the change
  // request merges into.
  failingOnBase(): Promise<string[]>;
}

export interface PlatformCheck {
  name: string;
  state: "passed" | "failed" | "pending";
  // The end of its failed job's output, else what the check reported of
  // itself; "" when the platform gives neither or the token may not read it.
  log(): Promise<string>;
}

export interface PlatformDiscussion {
  // `editor`: who edited it after posting, when someone did.
  comment: PlatformComment & { editor?: string };
  // Its thread's comments before and after it, oldest first; for a comment
  // on the change request as a whole, the change request's.
  earlier: { author: string; body: string }[];
  later: { author: string; body: string }[];
  on?: { path: string; line?: number };
  // Where a reply goes, in the platform's terms.
  replyTo?: string;
}

export interface Bot {
  login: string;
  // Platforms can spell one account in more than one way.
  is(login: string): boolean;
}

export interface PlatformChangeRequest {
  id: string;
  title: string;
  description: string;
  baseSha: string;
  headSha: string;
  branch?: string;
  // Absent when the platform does not say, for a deleted account.
  author?: string;
}

export interface PlatformComment {
  id: string;
  author?: string;
  body: string;
}

export interface PlatformThread {
  id: string;
  resolved: boolean;
  resolvedBy?: string;
  // In order; the first carries ocra's finding marker. `editor` is set when
  // someone edited the comment after posting it.
  comments: { author: string; body: string; editor?: string }[];
}

// A finding on lines of the diff that has no inline comment yet.
export interface InlineFinding {
  finding: Finding & { lineRange: NonNullable<Finding["lineRange"]> };
  body: string;
}

export interface PublishedFindings {
  // Fingerprints that now have an inline comment.
  posted: string[];
  warnings: string[];
  // Runs once the summary is written: GitHub withdraws a request for
  // changes that no longer blocks.
  finish?: () => Promise<string[]>;
}
