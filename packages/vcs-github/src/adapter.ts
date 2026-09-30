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
import { lostProgress, type ReviewState, readState, SUMMARY_MARKER } from "./state.js";

export interface GitHubPullRequest {
  owner: string;
  repo: string;
  number: number;
}

// Where the code under review is read from: the CLI passes the local git
// adapter on the pull request's base..head range.
export type CodeSource = Pick<VcsAdapter, "getDiff" | "readFile" | "searchCode">;

// The repository's history, to review only what changed since the previous
// review. The CLI answers from the local clone.
export interface History {
  filesChangedSince(from: string, to: string): Promise<{ files: string[] } | { reason: string }>;
}

export interface GitHubAdapterOptions {
  pullRequest: GitHubPullRequest;
  api: GitHubApi;
  code: CodeSource;
  // Only comments by this account count as ocra's earlier review.
  botLogin: string;
  requestChanges?: boolean;
  history?: History;
  // The pull request as the diff under review was built from it. Without it
  // the adapter fetches the pull request itself, and a push in between would
  // publish the new head for the old diff.
  snapshot?: PullRequest;
}

export const DEFAULT_BOT_LOGIN = "github-actions[bot]";

const OVERRIDE = /^\/ocra override ([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)\s+(\S.*)$/m;
const MAX_OVERRIDE_REASON = 300;
const MAX_REPLIES = 3;
const MAX_REPLY_CHARS = 1_000;

const DECLINE =
  /^(won['’]?t fix|wontfix|will not fix|by design|false positive|not a bug|working as intended|intended behaviou?r)(?=$|[\s.,;:!—–-])/i;
const COMMAND = /^\/ocra dismiss\b/im;

// A dismissal takes a clear decline: an explicit `/ocra dismiss`, or a reply
// that opens with a decline and does not ask. Words anywhere else in a reply
// ("this is not intended", "is this by design?", "acknowledged, will fix")
// do not dismiss, since a dismissed finding leaves the verdict. Disagreement
// ("I disagree") keeps the finding reported.
export function declinesFinding(reply: string): boolean {
  if (COMMAND.test(reply)) return true;
  const opening =
    reply
      .trim()
      .split(/(?<=[.!?])\s|\n/)[0]
      ?.trim() ?? "";
  return DECLINE.test(opening) && !opening.endsWith("?");
}

export class GitHubAdapter implements VcsAdapter {
  readonly name = "github";
  private pullRequest: Promise<PullRequest> | undefined;
  private previous: Promise<IssueComment | undefined> | undefined;
  private reviewThreads: Promise<ReviewThread[]> | undefined;
  private issueComments: Promise<IssueComment[]> | undefined;
  private readonly writers = new Map<string, Promise<boolean>>();
  private prior: Promise<{ state?: ReviewState } | { untrusted: string }> | undefined;

  constructor(private readonly options: GitHubAdapterOptions) {}

  async getChangeRequest(): Promise<ChangeRequest> {
    const pr = await this.pr();
    const { owner, repo } = this.options.pullRequest;
    const override = await this.override(pr);
    return {
      id: `${owner}/${repo}#${pr.number}`,
      title: pr.title,
      description: pr.body ?? "",
      baseSha: pr.base.sha,
      headSha: pr.head.sha,
      ...(override ? { override } : {}),
    };
  }

  // "Break glass": `/ocra override <commit> <reason>` from someone with
  // write access other than the author lets a blocking verdict pass for that
  // commit only, so a later push with new problems needs a new decision. The
  // author can never overrule the review of their own change. Comments are
  // best effort: without them there is simply no override.
  private async override(pr: PullRequest): Promise<ChangeRequest["override"]> {
    const comments = await this.comments().catch(() => []);
    const author = pr.user?.login;
    let found: ChangeRequest["override"];
    for (const c of comments) {
      const login = c.user?.login;
      const match = OVERRIDE.exec(c.body);
      if (!match || !login || login === author || this.isBot(login)) continue;
      // ocra's own summary is never a command, whichever account posted it.
      if (c.body.includes(SUMMARY_MARKER)) continue;
      const [, commit = "", reason = ""] = match;
      // The full commit id: a short prefix can be matched by a new commit.
      if (commit.toLowerCase() !== pr.head.sha) continue;
      if (!(await this.unedited(c.node_id, login)) || !(await this.canWrite(login))) continue;
      found = { by: login, reason: reason.trim().slice(0, MAX_OVERRIDE_REASON) };
    }
    return found;
  }

  // Anyone with write access can edit anyone's comment, and GitHub keeps
  // showing the original author: a command counts only when nobody else
  // edited it. Unknown means no.
  private async unedited(nodeId: string | undefined, login: string): Promise<boolean> {
    if (!nodeId) return false;
    try {
      const editor = await this.options.api.commentEditor(nodeId);
      return editor === undefined || editor === login;
    } catch {
      return false;
    }
  }

  // Write access from the repository's permissions, memoized per login;
  // a failed lookup means no.
  private canWrite(login: string): Promise<boolean> {
    let known = this.writers.get(login);
    if (!known) {
      known = this.options.api.canWrite(login).catch(() => false);
      this.writers.set(login, known);
    }
    return known;
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
    const prior = await this.priorState();
    if ("untrusted" in prior) return { findings: [], fullReviewReason: prior.untrusted };
    const { state } = prior;
    if (!state) return undefined;
    const { dismissed, replies } = await this.repliesByPeople(state.findings);
    return {
      findings: state.findings.map((f) =>
        dismissed.has(f.fingerprint) ? { ...f, dismissed: true } : f,
      ),
      ...(await this.changesSince(state)),
      ...(state.tier ? { tier: state.tier } : {}),
      ...(Object.keys(replies).length > 0 ? { replies } : {}),
    };
  }

  // Anyone with write access can edit the summary comment, including a pull
  // request's author. Every part of the state is then suspect: a head skips
  // their next changes, a `commented` flag hides a finding from both the
  // inline comments and the summary. So the state counts only when ocra was
  // the last to edit the comment; otherwise the run starts over.
  private priorState(): Promise<{ state?: ReviewState } | { untrusted: string }> {
    this.prior ??= (async () => {
      const comment = await this.summaryComment();
      const state = comment ? readState(comment.body) : undefined;
      if (!comment || !state) return {};
      const editor = await this.lastEditor(comment);
      if (editor === undefined) {
        return { untrusted: "could not check who last edited the previous review's summary" };
      }
      if (!this.isBot(editor)) {
        return { untrusted: "the previous review's summary was edited by someone else" };
      }
      return { state };
    })();
    return this.prior;
  }

  private async changesSince(
    state: ReviewState,
  ): Promise<Pick<PriorReview, "changedSince" | "fullReviewReason">> {
    const { history } = this.options;
    if (!state.head) return { fullReviewReason: "the previous review did not record its commit" };
    if (!history) return { fullReviewReason: "no repository history to compare with" };
    const head = (await this.pr()).head.sha;
    const changed = await history.filesChangedSince(state.head, head);
    if ("reason" in changed) return { fullReviewReason: changed.reason };
    return {
      changedSince: {
        head: state.head,
        files: [...new Set([...changed.files, ...(state.pending ?? [])])],
      },
    };
  }

  // A thread of ocra's that a reviewer resolved, or answered with a clear
  // "won't fix", dismisses its finding. A reviewer is someone with write
  // access other than the pull request's author, in a comment nobody else
  // edited: otherwise the author could resolve or argue a finding away. Any
  // other reply from a reviewer dismisses nothing, but the judge weighs it
  // when the finding comes back (and cannot drop a confirmed critical for
  // it). Replies are collected for every thread of ocra's, not only tracked
  // findings, so a finding a reply argued away does not return without it.
  // Thread data is best effort: without it nothing is dismissed or replied.
  private async repliesByPeople(
    findings: readonly PriorFinding[],
  ): Promise<{ dismissed: Set<string>; replies: Record<string, string[]> }> {
    const commented = new Set(findings.filter((f) => f.commented).map((f) => f.fingerprint));
    const author = (await this.pr()).user?.login;
    const reviewer = async (login: string | undefined) =>
      login !== undefined && login !== author && !this.isBot(login) && (await this.canWrite(login));
    const threads = await this.threads().catch(() => []);
    const dismissed = new Set<string>();
    const replies: Record<string, string[]> = {};
    for (const thread of threads) {
      const [first, ...rest] = thread.comments;
      const fingerprint = first && FINDING_MARKER.exec(first.body)?.[1];
      if (!first || !fingerprint || !this.isBot(first.author)) continue;
      const said: string[] = [];
      let declined = false;
      for (const r of rest) {
        const own = r.editor === undefined || r.editor === r.author;
        if (!own || !(await reviewer(r.author))) continue;
        if (declinesFinding(r.body)) declined = true;
        else if (r.body.trim() !== "") said.push(r.body.trim().slice(0, MAX_REPLY_CHARS));
      }
      if (commented.has(fingerprint)) {
        const resolved = thread.isResolved && (await reviewer(thread.resolvedBy));
        if (resolved || declined) {
          dismissed.add(fingerprint);
          continue;
        }
      }
      if (said.length > 0) replies[fingerprint] = said.slice(-MAX_REPLIES);
    }
    return { dismissed, replies };
  }

  async publish(report: ReviewReport): Promise<{ warnings: string[] }> {
    const { number } = this.options.pullRequest;
    const pr = await this.pr();
    const previous = await this.summaryComment();
    const prior = await this.priorState();
    const trusted = "state" in prior ? prior.state : undefined;
    const before = trusted?.findings ?? [];
    const alreadyCommented = new Set([
      ...before.filter((f) => f.commented).map((f) => f.fingerprint),
      ...(trusted?.posted ?? []),
    ]);

    const fresh = report.findings.flatMap((f) => {
      if (alreadyCommented.has(f.fingerprint)) return [];
      const comment = inlineComment(f);
      return comment ? [{ fingerprint: f.fingerprint, comment }] : [];
    });
    const changeRequests = await this.syncChangeRequest(number, report);
    const posted = await this.postReview(
      number,
      pr.head.sha,
      report,
      fresh,
      changeRequests.request,
    );

    const commented = new Set([...alreadyCommented, ...posted]);
    const current = new Set(report.findings.map((f) => f.fingerprint));
    const rereview = report.rereview;
    const quiet = [
      ...(rereview?.notReproduced ?? []),
      ...(rereview?.notRechecked ?? []),
      ...(rereview?.unchanged ?? []),
      ...(rereview?.dismissed ?? []),
    ];
    // Low-confidence findings (--ultra) are shown, not counted; stored as
    // ordinary findings they would count on the next push.
    const state: PriorFinding[] = [
      ...report.findings
        .filter((f) => !f.lowConfidence)
        .map((f) => ({
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
    const pending = report.coverage
      .filter((c) => c.status === "failed" || c.status === "unreviewed")
      .map((c) => c.path);
    const tracked = new Set(state.map((f) => f.fingerprint));
    const untracked = [...commented].filter((fp) => !tracked.has(fp));
    const body = renderSummary({
      report,
      commented,
      state: {
        findings: state,
        head: report.changeRequest.headSha,
        pending,
        tier: report.tier,
        ...(untracked.length > 0 ? { posted: untracked } : {}),
      },
    });
    if (previous) await this.options.api.updateIssueComment(previous.id, body);
    else await this.options.api.createIssueComment(number, body);
    const lost = lostProgress(body, pending.length);
    return {
      warnings: [
        ...(lost ? [lost] : []),
        ...changeRequests.warnings,
        ...(await changeRequests.withdraw()),
        ...(await this.resolveFixedThreads(number, report)),
      ],
    };
  }

  // With requestChanges on, ocra's "changes requested" follows the verdict:
  // requested once while it blocks, withdrawn (dismissed) once it no longer
  // does. GitHub keeps a reviewer's last blocking review until it is
  // dismissed, so otherwise a fixed pull request stayed blocked.
  private async syncChangeRequest(
    number: number,
    report: ReviewReport,
  ): Promise<{ request: boolean; warnings: string[]; withdraw(): Promise<string[]> }> {
    const none = { request: false, warnings: [], withdraw: async () => [] };
    if (this.options.requestChanges !== true) return none;
    // An override lets the commit pass, so it lifts the request too.
    const blocking =
      report.verdict === "significant_concerns" && report.changeRequest.override === undefined;
    let active: number[];
    try {
      active = (await this.options.api.listReviews(number))
        .filter((r) => r.state === "CHANGES_REQUESTED" && r.user && this.isBot(r.user.login))
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

  // The account that last edited the comment (ocra itself when nobody did),
  // or undefined when that cannot be told.
  private async lastEditor(comment: IssueComment): Promise<string | undefined> {
    if (!comment.node_id) return undefined;
    try {
      return (await this.options.api.commentEditor(comment.node_id)) ?? this.options.botLogin;
    } catch {
      return undefined;
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
    requestChanges: boolean,
  ): Promise<string[]> {
    // GitHub rejects the whole review when one comment sits on a file it
    // shows no diff for (too large, too many files); those go to the summary.
    if (fresh.length > 0) {
      const shown = await this.options.api.filesWithDiff(number).catch(() => undefined);
      if (shown) fresh = fresh.filter((f) => shown.has(f.comment.path));
    }
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
      // The request for changes still matters; if GitHub refuses it too (for
      // example on the token owner's own pull request), the summary remains.
      if (requestChanges) {
        await this.options.api.createReview(number, { ...review, comments: [] }).catch(() => {});
      }
      return [];
    }
  }

  private threads(): Promise<ReviewThread[]> {
    this.reviewThreads ??= this.options.api.listReviewThreads(this.options.pullRequest.number);
    return this.reviewThreads;
  }

  private pr(): Promise<PullRequest> {
    this.pullRequest ??= this.options.snapshot
      ? Promise.resolve(this.options.snapshot)
      : this.options.api.getPullRequest(this.options.pullRequest.number);
    return this.pullRequest;
  }

  private comments(): Promise<IssueComment[]> {
    this.issueComments ??= this.options.api.listIssueComments(this.options.pullRequest.number);
    return this.issueComments;
  }

  private summaryComment(): Promise<IssueComment | undefined> {
    this.previous ??= this.comments().then((comments) =>
      comments.findLast(
        (c) => c.user?.login === this.options.botLogin && c.body.includes(SUMMARY_MARKER),
      ),
    );
    return this.previous;
  }
}
