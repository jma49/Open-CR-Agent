import type {
  ChangeRequest,
  CodeMatch,
  FileDiff,
  PriorFinding,
  PriorReview,
  ReviewReport,
  VcsAdapter,
} from "@open-cr-agent/core";
import { errorMessage, isUnfinished } from "@open-cr-agent/core";
import type {
  Bot,
  InlineFinding,
  PlatformChangeRequest,
  PlatformComment,
  PlatformThread,
  ReviewPlatform,
} from "./platform.js";
import { FINDING_MARKER, inlineBody, renderSummary } from "./render.js";
import { lostProgress, type ReviewState, readState, SUMMARY_MARKER } from "./state.js";

// Where the code under review is read from: the CLI passes the local git
// adapter on the change request's base..head range.
export type CodeSource = Pick<VcsAdapter, "getDiff" | "readFile" | "searchCode">;

// The repository's history, to review only what changed since the previous
// review. The CLI answers from the local clone.
export interface History {
  filesChangedSince(from: string, to: string): Promise<{ files: string[] } | { reason: string }>;
}

export interface PlatformReviewOptions {
  name: string;
  platform: ReviewPlatform;
  code: CodeSource;
  history?: History;
}

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

// The review conversation on a code review platform, the same on every one:
// which earlier state and which comments count, who may override or dismiss,
// and what gets posted. The platform only maps its API (ReviewPlatform).
export class PlatformReview implements VcsAdapter {
  readonly name: string;
  private readonly platform: ReviewPlatform;
  private readonly memo = new Map<string, Promise<unknown>>();
  private readonly writers = new Map<string, Promise<boolean>>();

  private readonly options: PlatformReviewOptions;

  constructor(options: PlatformReviewOptions) {
    this.options = options;
    this.name = options.name;
    this.platform = options.platform;
  }

  async getChangeRequest(): Promise<ChangeRequest> {
    const cr = await this.changeRequest();
    const override = await this.override(cr);
    return {
      id: cr.id,
      title: cr.title,
      description: cr.description,
      baseSha: cr.baseSha,
      headSha: cr.headSha,
      ...(override ? { override } : {}),
    };
  }

  // "Break glass": `/ocra override <commit> <reason>` from someone with
  // write access other than the author lets a blocking verdict pass for that
  // commit only, so a later push with new problems needs a new decision. The
  // author can never overrule the review of their own change. Comments are
  // best effort: without them there is simply no override.
  private async override(cr: PlatformChangeRequest): Promise<ChangeRequest["override"]> {
    const comments = await this.comments().catch(() => []);
    const bot = await this.bot();
    let found: ChangeRequest["override"];
    for (const c of comments) {
      const login = c.author;
      const match = OVERRIDE.exec(c.body);
      if (!match || !login || login === cr.author || bot.is(login)) continue;
      // ocra's own summary is never a command, whichever account posted it.
      if (c.body.includes(SUMMARY_MARKER)) continue;
      const [, commit = "", reason = ""] = match;
      // The full commit id: a short prefix can be matched by a new commit.
      if (commit.toLowerCase() !== cr.headSha) continue;
      if (!(await this.unedited(c, login)) || !(await this.canWrite(login))) continue;
      found = { by: login, reason: reason.trim().slice(0, MAX_OVERRIDE_REASON) };
    }
    return found;
  }

  // Anyone with write access can edit anyone's comment, and the platform
  // keeps showing the original author: a command counts only when nobody
  // else edited it. Unknown means no.
  private async unedited(comment: PlatformComment, login: string): Promise<boolean> {
    try {
      const editor = await this.platform.editor(comment);
      return editor === undefined || editor === login;
    } catch {
      return false;
    }
  }

  // Write access from the platform, memoized per login; a failed lookup
  // means no.
  private canWrite(login: string): Promise<boolean> {
    let known = this.writers.get(login);
    if (!known) {
      known = this.platform.canWrite(login).catch(() => false);
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

  // Anyone with write access can edit the summary comment, including a
  // change request's author. Every part of the state is then suspect: a head
  // skips their next changes, a `commented` flag hides a finding from both
  // the inline comments and the summary. So the state counts only when ocra
  // was the last to edit the comment; otherwise the run starts over.
  private priorState(): Promise<{ state?: ReviewState } | { untrusted: string }> {
    return this.once("prior", async () => {
      const comment = await this.summaryComment();
      const state = comment ? readState(comment.body) : undefined;
      if (!comment || !state) return {};
      const editor = await this.lastEditor(comment);
      if (editor === undefined) {
        return { untrusted: "could not check who last edited the previous review's summary" };
      }
      if (!(await this.bot()).is(editor)) {
        return { untrusted: "the previous review's summary was edited by someone else" };
      }
      return { state };
    });
  }

  private async changesSince(
    state: ReviewState,
  ): Promise<Pick<PriorReview, "changedSince" | "fullReviewReason">> {
    const { history } = this.options;
    if (!state.head) return { fullReviewReason: "the previous review did not record its commit" };
    if (!history) return { fullReviewReason: "no repository history to compare with" };
    const head = (await this.changeRequest()).headSha;
    const changed = await history.filesChangedSince(state.head, head);
    if ("reason" in changed) return { fullReviewReason: changed.reason };
    return {
      changedSince: {
        head: state.head,
        files: [...new Set([...changed.files, ...(state.pending ?? [])])],
      },
    };
  }

  // A thread of ocra's that a maintainer resolved, or answered with a clear
  // "won't fix", dismisses its finding. A maintainer is someone with write
  // access other than the change request's author, in a comment nobody else
  // edited: otherwise the author could resolve or argue a finding away. Any
  // other reply from a maintainer dismisses nothing, but the judge weighs it
  // when the finding comes back (and cannot drop a confirmed critical for
  // it). Replies are collected for every thread of ocra's, not only tracked
  // findings, so a finding a reply argued away does not return without it.
  // Thread data is best effort: without it nothing is dismissed or replied.
  private async repliesByPeople(
    findings: readonly PriorFinding[],
  ): Promise<{ dismissed: Set<string>; replies: Record<string, string[]> }> {
    const commented = new Set(findings.filter((f) => f.commented).map((f) => f.fingerprint));
    const author = (await this.changeRequest()).author;
    const bot = await this.bot();
    const maintainer = async (login: string | undefined) =>
      login !== undefined && login !== author && !bot.is(login) && (await this.canWrite(login));
    const threads = await this.threads().catch(() => []);
    const dismissed = new Set<string>();
    const replies: Record<string, string[]> = {};
    for (const thread of threads) {
      const fingerprint = findingOf(thread, bot);
      if (!fingerprint) continue;
      const said: string[] = [];
      let declined = false;
      for (const r of thread.comments.slice(1)) {
        const own = r.editor === undefined || r.editor === r.author;
        if (!own || !(await maintainer(r.author))) continue;
        if (declinesFinding(r.body)) declined = true;
        else if (r.body.trim() !== "") said.push(r.body.trim().slice(0, MAX_REPLY_CHARS));
      }
      if (commented.has(fingerprint)) {
        const resolved = thread.resolved && (await maintainer(thread.resolvedBy));
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
    const previous = await this.summaryComment();
    const prior = await this.priorState();
    const trusted = "state" in prior ? prior.state : undefined;
    const before = trusted?.findings ?? [];
    const alreadyCommented = new Set([
      ...before.filter((f) => f.commented).map((f) => f.fingerprint),
      ...(trusted?.posted ?? []),
      ...(await this.ownThreads()),
    ]);

    const fresh: InlineFinding[] = report.findings.flatMap((f) => {
      if (alreadyCommented.has(f.fingerprint) || !f.lineRange || !f.anchor.inDiff) return [];
      return [
        {
          finding: { ...f, lineRange: f.lineRange },
          body: inlineBody(f, this.platform.suggestionFence),
        },
      ];
    });
    const published = await this.platform.publishFindings(report, fresh);

    const commented = new Set([...alreadyCommented, ...published.posted]);
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
          reviewer: f.reviewer,
        })),
      ...quiet.filter((f) => !current.has(f.fingerprint)),
    ];
    const pending = report.coverage.filter(isUnfinished).map((c) => c.path);
    const tracked = new Set(state.map((f) => f.fingerprint));
    const untracked = [...commented].filter((fp) => !tracked.has(fp));
    const unattributed = await this.unattributedResolutions(current);
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
      text: this.platform.text,
      unattributed,
    });
    await this.platform.writeSummary(previous, body);
    const lost = lostProgress(body, pending.length);
    return {
      warnings: [
        ...(lost ? [lost] : []),
        ...published.warnings,
        ...((await published.finish?.()) ?? []),
        ...(await this.resolveFixedThreads(report)),
      ],
    };
  }

  // Findings ocra already commented on inline, from its own threads, so a
  // run that stopped between posting them and writing the summary, or a
  // summary whose state no longer counts, does not post them twice.
  private async ownThreads(): Promise<string[]> {
    const bot = await this.bot();
    const threads = await this.threads().catch(() => []);
    return threads.flatMap((thread) => findingOf(thread, bot) ?? []);
  }

  // Findings still reported whose thread was resolved without saying by
  // whom: that resolution dismissed nothing, and the summary says why.
  private async unattributedResolutions(current: ReadonlySet<string>): Promise<number> {
    const bot = await this.bot();
    const threads = await this.threads().catch(() => []);
    return threads.filter((thread) => {
      const fingerprint = findingOf(thread, bot);
      return (
        thread.resolved &&
        thread.resolvedBy === undefined &&
        fingerprint !== undefined &&
        current.has(fingerprint)
      );
    }).length;
  }

  // Resolving threads is a courtesy: the summary already lists what was
  // fixed, so a failure here is a warning, not a failed publish.
  private async resolveFixedThreads(report: ReviewReport): Promise<string[]> {
    const fixed = new Set(
      (report.rereview?.fixed ?? []).filter((f) => f.commented).map((f) => f.fingerprint),
    );
    if (fixed.size === 0) return [];
    try {
      const bot = await this.bot();
      for (const thread of await this.threads()) {
        const fingerprint = findingOf(thread, bot);
        if (thread.resolved || !fingerprint || !fixed.has(fingerprint)) continue;
        await this.platform.resolveThread(thread.id);
      }
      return [];
    } catch (error) {
      return [`could not resolve the threads of fixed findings: ${errorMessage(error)}`];
    }
  }

  // The account that last edited the comment (ocra itself when nobody did),
  // or undefined when that cannot be told.
  private async lastEditor(comment: PlatformComment): Promise<string | undefined> {
    try {
      return (await this.platform.editor(comment)) ?? (await this.bot()).login;
    } catch {
      return undefined;
    }
  }

  // The last summary ocra posted: by the account's exact login, never by a
  // look-alike, since a comment counted as ocra's is trusted when unedited.
  private summaryComment(): Promise<PlatformComment | undefined> {
    return this.once("summary", async () => {
      const bot = await this.bot();
      return (await this.comments()).findLast(
        (c) => c.author === bot.login && c.body.includes(SUMMARY_MARKER),
      );
    });
  }

  private bot(): Promise<Bot> {
    return this.once("bot", () => this.platform.bot());
  }

  private changeRequest(): Promise<PlatformChangeRequest> {
    return this.once("changeRequest", () => this.platform.changeRequest());
  }

  private comments(): Promise<PlatformComment[]> {
    return this.once("comments", () => this.platform.comments());
  }

  private threads(): Promise<PlatformThread[]> {
    return this.once("threads", () => this.platform.threads());
  }

  // Platform data is read once per run: a second read could see a comment
  // posted in between and disagree with the first.
  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let value = this.memo.get(key) as Promise<T> | undefined;
    if (!value) {
      value = load();
      this.memo.set(key, value);
    }
    return value;
  }
}

// The finding a thread of ocra's is about: its first comment is ocra's, with
// a marker, and nobody else edited it. An edited marker could point a
// reviewer's resolution or reply at another finding, or hide one.
function findingOf(thread: PlatformThread, bot: Bot): string | undefined {
  const first = thread.comments[0];
  const fingerprint = first && FINDING_MARKER.exec(first.body)?.[1];
  if (!first || !fingerprint || !bot.is(first.author)) return undefined;
  return first.editor === undefined || bot.is(first.editor) ? fingerprint : undefined;
}
