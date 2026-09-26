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
import { type GitHubApi, GitHubApiError, type IssueComment, type PullRequest } from "./client.js";
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

export class GitHubAdapter implements VcsAdapter {
  readonly name = "github";
  private pullRequest: Promise<PullRequest> | undefined;
  private previous: Promise<IssueComment | undefined> | undefined;

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
    return findings ? { findings } : undefined;
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
    const state: PriorFinding[] = [
      ...report.findings.map((f) => ({
        fingerprint: f.fingerprint,
        title: f.title,
        file: f.file,
        severity: f.severity,
        commented: commented.has(f.fingerprint),
      })),
      ...(report.rereview?.notRechecked ?? []).filter((f) => !current.has(f.fingerprint)),
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
      const threads = await this.options.api.listReviewThreads(number);
      for (const thread of threads) {
        const fingerprint = FINDING_MARKER.exec(thread.body)?.[1];
        if (thread.isResolved || !fingerprint || !fixed.has(fingerprint)) continue;
        if (!this.isBot(thread.author)) continue;
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
