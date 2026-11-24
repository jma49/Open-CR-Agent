import {
  type ChangeCommit,
  type CommitResult,
  errorMessage,
  isBlocking,
  type LinkedTask,
  type MentionRef,
  OcraError,
  type ReviewReport,
} from "@open-cr-agent/core";
import {
  type Bot,
  type CodeSource,
  githubSuggestion,
  type History,
  type InlineFinding,
  type MergeSource,
  type PlatformChangeRequest,
  type PlatformCheck,
  type PlatformComment,
  type PlatformDiscussion,
  PlatformReview,
  type PlatformThread,
  type PublishedFindings,
  type ReviewPlatform,
} from "@open-cr-agent/vcs-platform";
import { checkOutcome, stoppedOutcome } from "@open-cr-agent/vcs-platform/internal";
import { githubChecks, githubFailingOnBase } from "./checks.js";
import {
  type GitHubApi,
  GitHubApiError,
  type IssueComment,
  type PullRequest,
  type ReviewComment,
} from "./client.js";
import { githubBaseHead, githubCommit, githubPushBranch } from "./commit.js";
import { githubDiscussion } from "./discussion.js";
import { ReviewCheck } from "./review-check.js";
import { githubLinkedTasks } from "./tasks.js";

export interface GitHubPullRequest {
  owner: string;
  repo: string;
  number: number;
}

export interface GitHubAdapterOptions {
  pullRequest: GitHubPullRequest;
  api: GitHubApi;
  code: CodeSource;
  // Only comments by this account count as ocra's earlier review.
  botLogin: string;
  requestChanges?: boolean;
  history?: History;
  merge?: MergeSource;
  // The pull request as the diff under review was built from it. Without it
  // the adapter fetches the pull request itself, and a push in between would
  // publish the new head for the old diff.
  snapshot?: PlatformChangeRequest;
  // The "ocra review" check run to take over, when ocra Cloud queued one.
  checkRunId?: number;
}

export const DEFAULT_BOT_LOGIN = "github-actions[bot]";

// A GitHub pull request as ocra's review conversation (vcs-platform).
export class GitHubAdapter extends PlatformReview {
  private readonly github: GitHubAdapterOptions;
  private readonly check: ReviewCheck;

  constructor(options: GitHubAdapterOptions) {
    super({
      name: "github",
      platform: new GitHubPlatform(options),
      code: options.code,
      ...(options.history ? { history: options.history } : {}),
      ...(options.merge ? { merge: options.merge } : {}),
    });
    this.github = options;
    this.check = new ReviewCheck(options.api, options.checkRunId);
  }

  async started(): Promise<{ warnings: string[] }> {
    const { snapshot, api, pullRequest } = this.github;
    const headSha = snapshot?.headSha ?? (await api.getPullRequest(pullRequest.number)).head.sha;
    return { warnings: await this.check.start(headSha) };
  }

  async stopped(reason: string): Promise<{ warnings: string[] }> {
    return { warnings: await this.check.finish(stoppedOutcome(reason)) };
  }

  override async publish(report: ReviewReport): Promise<{ warnings: string[] }> {
    let published: { warnings: string[] };
    try {
      published = await super.publish(report);
    } catch (error) {
      await this.check.finish(stoppedOutcome(`Publishing failed: ${errorMessage(error)}`));
      throw error;
    }
    return {
      warnings: [...published.warnings, ...(await this.check.finish(checkOutcome(report)))],
    };
  }
}

class GitHubPlatform implements ReviewPlatform {
  readonly text = { changeRequest: "pull request", authority: "write access" };
  readonly suggestionFence = githubSuggestion;
  private pullRequest: Promise<PlatformChangeRequest> | undefined;
  // The REST comments behind the platform's, for their GraphQL node ids.
  private readonly listed = new Map<string, IssueComment>();

  private readonly options: GitHubAdapterOptions;

  constructor(options: GitHubAdapterOptions) {
    this.options = options;
  }

  // REST names the Actions bot "github-actions[bot]", GraphQL "github-actions".
  async bot(): Promise<Bot> {
    const login = this.options.botLogin;
    return { login, is: (other) => other === login || `${other}[bot]` === login };
  }

  changeRequest(): Promise<PlatformChangeRequest> {
    const { pullRequest } = this.options;
    this.pullRequest ??= this.options.snapshot
      ? Promise.resolve(this.options.snapshot)
      : this.options.api
          .getPullRequest(pullRequest.number)
          .then((pr) => pullRequestOf(pr, pullRequest));
    return this.pullRequest;
  }

  async comments(): Promise<PlatformComment[]> {
    const comments = await this.options.api.listIssueComments(this.options.pullRequest.number);
    return comments.map((c) => {
      const id = String(c.id);
      this.listed.set(id, c);
      return { id, body: c.body, ...(c.user ? { author: c.user.login } : {}) };
    });
  }

  // GitHub keeps who edited a comment in GraphQL only, by node id.
  async editor(comment: PlatformComment): Promise<string | undefined> {
    const nodeId = this.listed.get(comment.id)?.node_id;
    if (!nodeId)
      throw new OcraError("VCS_API_FAILED", "the comment has no node id to look up its editor");
    return this.options.api.commentEditor(nodeId);
  }

  canWrite(login: string): Promise<boolean> {
    return this.options.api.canWrite(login);
  }

  async threads(): Promise<PlatformThread[]> {
    const threads = await this.options.api.listReviewThreads(this.options.pullRequest.number);
    return threads.map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      ...(t.resolvedBy ? { resolvedBy: t.resolvedBy } : {}),
      comments: t.comments.map((c) => ({
        author: c.author,
        body: c.body,
        ...(c.editor ? { editor: c.editor } : {}),
      })),
    }));
  }

  linkedTasks(): Promise<LinkedTask[]> {
    return githubLinkedTasks(this.options.api, this.options.pullRequest);
  }

  async publishFindings(
    report: ReviewReport,
    fresh: readonly InlineFinding[],
  ): Promise<PublishedFindings> {
    const changeRequests = await this.syncChangeRequest(report);
    const posted = await this.postReview(report, fresh, changeRequests.request);
    return { posted, warnings: changeRequests.warnings, finish: changeRequests.withdraw };
  }

  async writeSummary(existing: PlatformComment | undefined, body: string): Promise<void> {
    if (existing) await this.options.api.updateIssueComment(Number(existing.id), body);
    else await this.options.api.createIssueComment(this.options.pullRequest.number, body);
  }

  resolveThread(id: string): Promise<void> {
    return this.options.api.resolveReviewThread(id);
  }

  discussion(ref: MentionRef): Promise<PlatformDiscussion | undefined> {
    return githubDiscussion(this.options.api, this.options.pullRequest.number, ref);
  }

  async reply(discussion: PlatformDiscussion, body: string): Promise<void> {
    const { number } = this.options.pullRequest;
    if (discussion.replyTo === undefined) await this.options.api.createIssueComment(number, body);
    else await this.options.api.replyToLineComment(number, Number(discussion.replyTo), body);
  }

  commit(commit: ChangeCommit): Promise<CommitResult> {
    return githubCommit(this.options.api, this.options.pullRequest, commit);
  }

  baseHead(): Promise<string> {
    return githubBaseHead(this.options.api, this.options.pullRequest.number);
  }

  async pushTarget() {
    const target = await githubPushBranch(this.options.api, this.options.pullRequest);
    if ("refused" in target) return target;
    const name = this.options.botLogin;
    return { ...target, author: { name, email: await this.options.api.noreplyEmail(name) } };
  }

  // The sha is the pull request's head as the adapter's own read gave it.
  checks(sha: string): Promise<PlatformCheck[]> {
    return githubChecks(this.options.api, encodeURIComponent(sha));
  }

  failingOnBase(): Promise<string[]> {
    return githubFailingOnBase(this.options.api, this.options.pullRequest.number);
  }

  // With requestChanges on, ocra's "changes requested" follows the verdict:
  // requested once while it blocks, withdrawn (dismissed) once it no longer
  // does. GitHub keeps a reviewer's last blocking review until it is
  // dismissed, so otherwise a fixed pull request stayed blocked.
  private async syncChangeRequest(
    report: ReviewReport,
  ): Promise<{ request: boolean; warnings: string[]; withdraw(): Promise<string[]> }> {
    const none = { request: false, warnings: [], withdraw: async () => [] };
    if (this.options.requestChanges !== true) return none;
    const { number } = this.options.pullRequest;
    const bot = await this.bot();
    // An override lets the commit pass, so it lifts the request too.
    const blocking = isBlocking(report);
    let active: number[];
    try {
      active = (await this.options.api.listReviews(number))
        .filter((r) => r.state === "CHANGES_REQUESTED" && r.user && bot.is(r.user.login))
        .map((r) => r.id);
    } catch (error) {
      return {
        request: blocking,
        warnings: [`could not list earlier reviews: ${errorMessage(error)}`],
        withdraw: async () => [],
      };
    }
    if (blocking) return { ...none, request: active.length === 0 };
    return {
      request: false,
      warnings: [],
      withdraw: async () => {
        const warnings: string[] = [];
        for (const id of active) {
          await this.options.api
            .dismissReview(
              number,
              id,
              `ocra: no blocking findings remain (verdict: ${report.verdict.replaceAll("_", " ")}).`,
            )
            .catch((error) =>
              warnings.push(
                `could not withdraw ocra's request for changes: ${errorMessage(error)}`,
              ),
            );
        }
        return warnings;
      },
    };
  }

  // Returns the fingerprints that now have inline comments. GitHub rejects
  // positions outside its own diff with 422; those findings then stay in the
  // summary instead of failing the publish.
  private async postReview(
    report: ReviewReport,
    inline: readonly InlineFinding[],
    requestChanges: boolean,
  ): Promise<string[]> {
    const { number } = this.options.pullRequest;
    let fresh = inline.map((f) => ({
      fingerprint: f.finding.fingerprint,
      comment: reviewComment(f),
    }));
    // GitHub rejects the whole review when one comment sits on a file it
    // shows no diff for (too large, too many files); those go to the summary.
    if (fresh.length > 0) {
      const shown = await this.options.api.filesWithDiff(number).catch(() => undefined);
      if (shown) fresh = fresh.filter((f) => shown.has(f.comment.path));
    }
    if (fresh.length === 0 && !requestChanges) return [];
    const review = {
      commit_id: (await this.changeRequest()).headSha,
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
      // The request for changes still matters; if GitHub refuses it too (for
      // example on the token owner's own pull request), the summary remains.
      if (requestChanges) {
        await this.options.api.createReview(number, { ...review, comments: [] }).catch(() => {});
      }
      return [];
    }
  }
}

// The pull request as ocra's review conversation reads it.
export function pullRequestOf(
  pr: PullRequest,
  { owner, repo }: Pick<GitHubPullRequest, "owner" | "repo">,
): PlatformChangeRequest {
  return {
    id: `${owner}/${repo}#${pr.number}`,
    title: pr.title,
    description: pr.body ?? "",
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
    branch: pr.head.ref,
    ...(pr.user ? { author: pr.user.login } : {}),
  };
}

function reviewComment({ finding, body }: InlineFinding): ReviewComment {
  const { start, end } = finding.lineRange;
  const comment: ReviewComment = { path: finding.file, line: end, side: "RIGHT", body };
  if (start !== end) {
    comment.start_line = start;
    comment.start_side = "RIGHT";
  }
  return comment;
}
