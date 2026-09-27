import {
  type ChangeRequest,
  type CodeMatch,
  errorMessage,
  type FileDiff,
  type PriorFinding,
  type PriorReview,
  type ReviewReport,
  type VcsAdapter,
} from "@open-cr-agent/core";
import {
  type GitHubApi,
  GitHubApiError,
  type IssueComment,
  type PullRequest,
  type ReviewThread,
} from "./client.js";
import { FINDING_MARKER, inlineComment, renderSummary } from "./render.js";
import { readState, SUMMARY_MARKER } from "./state.js";

export interface GitHubPullRequest {
  owner: string;
  repo: string;
  number: number;
}

// Where the code under review is read from: the CLI passes the local git
// adapter on the pull request's base..head range.
export type CodeSource = Pick<VcsAdapter, "getDiff" | "readFile" | "searchCode">;

export interface GitHubAdapterOptions {
  pullRequest: GitHubPullRequest;
  api: GitHubApi;
  code: CodeSource;
  // Only comments by this account count as ocra's earlier review.
  botLogin: string;
  requestChanges?: boolean;
}

export const DEFAULT_BOT_LOGIN = "github-actions[bot]";

// Replies that decline a finding. Disagreement ("I disagree") is not a
// dismissal: the finding keeps being reported.
const WRITE_ACCESS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const DISMISSAL =
  /\b(won'?t fix|wontfix|not a bug|by design|acknowledged|intended|intentional|false positive)\b/i;

export class GitHubAdapter implements VcsAdapter {
  readonly name = "github";
  private pullRequest: Promise<PullRequest> | undefined;
  private previous: Promise<IssueComment | undefined> | undefined;
  private reviewThreads: Promise<ReviewThread[]> | undefined;

  constructor(private readonly options: GitHubAdapterOptions) {}

  async getChangeRequest(): Promise<ChangeRequest> {
    const pr = await this.pr();
    const { owner, repo } = this.options.pullRequest;
    return {
      id: `${owner}/${repo}#${pr.number}`,
      title: pr.title,
      description: pr.body ?? "",
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
    };
  }

  getDiff(): Promise<FileDiff[]> {
    return this.options.code.getDiff();
  }

  readFile(path: string): Promise<string | undefined> {
    return this.options.code.readFile(path);
  }

  searchCode(literal: string): Promise<CodeMatch[]> {
    return this.options.code.searchCode(literal);
  }

  async getPriorReview(): Promise<PriorReview | undefined> {
    const comment = await this.summaryComment();
    const findings = comment ? readState(comment.body) : undefined;
    if (!findings) return undefined;
    const dismissed = await this.dismissedByPeople(findings);
    return {
      findings: findings.map((f) => (dismissed.has(f.fingerprint) ? { ...f, dismissed: true } : f)),
    };
  }

  // A thread of ocra's that a reviewer resolved, or answered with a clear
  // "won't fix", dismisses its finding. A reviewer is someone with write
  // access other than the pull request's author: otherwise the author could
  // resolve a critical finding away and pass the check, and on a public
  // repository anyone could reply "won't fix". Thread data is best effort:
  // without it, findings are simply not dismissed.
  private async dismissedByPeople(findings: readonly PriorFinding[]): Promise<Set<string>> {
    const commented = new Set(findings.filter((f) => f.commented).map((f) => f.fingerprint));
    if (commented.size === 0) return new Set();
    const author = (await this.pr()).user?.login;
    const reviewer = (login: string | undefined) =>
      login !== undefined && login !== author && !this.isBot(login);
    const threads = await this.threads().catch(() => []);
    const dismissed = new Set<string>();
    for (const thread of threads) {
      const [first, ...replies] = thread.comments;
      const fingerprint = first && FINDING_MARKER.exec(first.body)?.[1];
      if (!first || !fingerprint || !commented.has(fingerprint) || !this.isBot(first.author))
        continue;
      // Only people with write access (or the author) can resolve threads.
      const resolvedByReviewer = thread.isResolved && reviewer(thread.resolvedBy);
      const declined = replies.some(
        (r) => reviewer(r.author) && WRITE_ACCESS.has(r.association) && DISMISSAL.test(r.body),
      );
      if (resolvedByReviewer || declined) dismissed.add(fingerprint);
    }
    return dismissed;
  }

  async publish(report: ReviewReport): Promise<{ warnings: string[] }> {
    const { number } = this.options.pullRequest;
    const pr = await this.pr();
    const previous = await this.summaryComment();
    const before = (previous ? readState(previous.body) : undefined) ?? [];
    const alreadyCommented = new Set(before.filter((f) => f.commented).map((f) => f.fingerprint));

    const fresh = report.findings.flatMap((f) => {
      if (alreadyCommented.has(f.fingerprint)) return [];
      const comment = inlineComment(f);
      return comment ? [{ fingerprint: f.fingerprint, comment }] : [];
    });
    const posted = await this.postReview(number, pr.head.sha, report, fresh);

    const commented = new Set([...alreadyCommented, ...posted]);
    const current = new Set(report.findings.map((f) => f.fingerprint));
    const rereview = report.rereview;
    const quiet = [
      ...(rereview?.notReproduced ?? []),
      ...(rereview?.notRechecked ?? []),
      ...(rereview?.dismissed ?? []),
    ];
    const state: PriorFinding[] = [
      ...report.findings.map((f) => ({
        fingerprint: f.fingerprint,
        title: f.title,
        file: f.file,
        severity: f.severity,
        commented: commented.has(f.fingerprint),
        ...(f.quote ? { quote: f.quote } : {}),
        ...(f.verification ? { verification: f.verification } : {}),
      })),
      ...quiet.filter((f) => !current.has(f.fingerprint)),
    ];
    const body = renderSummary({ report, commented, state });
    if (previous) await this.options.api.updateIssueComment(previous.id, body);
    else await this.options.api.createIssueComment(number, body);
    return { warnings: await this.resolveFixedThreads(number, report) };
  }

  // Resolving threads is a courtesy: the summary already lists what was
  // fixed, so a failure here is a warning, not a failed publish.
  private async resolveFixedThreads(number: number, report: ReviewReport): Promise<string[]> {
    const fixed = new Set(
      (report.rereview?.fixed ?? []).filter((f) => f.commented).map((f) => f.fingerprint),
    );
    if (fixed.size === 0) return [];
    try {
      for (const thread of await this.threads()) {
        const first = thread.comments[0];
        const fingerprint = first && FINDING_MARKER.exec(first.body)?.[1];
        if (thread.isResolved || !fingerprint || !fixed.has(fingerprint)) continue;
        if (!this.isBot(first.author)) continue;
        await this.options.api.resolveReviewThread(thread.id);
      }
      return [];
    } catch (error) {
      return [`could not resolve the threads of fixed findings: ${errorMessage(error)}`];
    }
  }

  // REST names the Actions bot "github-actions[bot]", GraphQL "github-actions".
  private isBot(login: string): boolean {
    return login === this.options.botLogin || `${login}[bot]` === this.options.botLogin;
  }

  // Returns the fingerprints that now have inline comments. GitHub rejects
  // positions outside its own diff with 422; those findings then stay in the
  // summary instead of failing the publish.
  private async postReview(
    number: number,
    commitId: string,
    report: ReviewReport,
    fresh: { fingerprint: string; comment: NonNullable<ReturnType<typeof inlineComment>> }[],
  ): Promise<string[]> {
    const requestChanges =
      this.options.requestChanges === true && report.verdict === "significant_concerns";
    if (fresh.length === 0 && !requestChanges) return [];
    const review = {
      commit_id: commitId,
      event: requestChanges ? ("REQUEST_CHANGES" as const) : ("COMMENT" as const),
      body: `ocra: ${report.findings.length} finding(s); details in the summary comment.`,
    };
    try {
      await this.options.api.createReview(number, {
        ...review,
        comments: fresh.map((f) => f.comment),
      });
      return fresh.map((f) => f.fingerprint);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
      if (requestChanges) await this.options.api.createReview(number, { ...review, comments: [] });
      return [];
    }
  }

  private threads(): Promise<ReviewThread[]> {
    this.reviewThreads ??= this.options.api.listReviewThreads(this.options.pullRequest.number);
    return this.reviewThreads;
  }

  private pr(): Promise<PullRequest> {
    this.pullRequest ??= this.options.api.getPullRequest(this.options.pullRequest.number);
    return this.pullRequest;
  }

  private summaryComment(): Promise<IssueComment | undefined> {
    this.previous ??= this.options.api
      .listIssueComments(this.options.pullRequest.number)
      .then((comments) =>
        comments.findLast(
          (c) => c.user?.login === this.options.botLogin && c.body.includes(SUMMARY_MARKER),
        ),
      );
    return this.previous;
  }
}
