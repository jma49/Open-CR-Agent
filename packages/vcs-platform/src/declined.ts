import type { ChangeRequest, PriorFinding } from "@open-cr-agent/core";
import { DISMISS } from "./commands.js";
import type { Bot, PlatformThread } from "./platform.js";
import { FINDING_MARKER } from "./render.js";

const DECLINE =
  /^(won['’]?t fix|wontfix|will not fix|by design|false positive|not a bug|working as intended|intended behaviou?r)(?=$|[\s.,;:!—–-])/i;
const MAX_REASON = 2_000;
const MAX_DECLINED = 50;

// A dismissal takes a clear decline: an explicit `@ocra dismiss`, or a reply
// that opens with a decline and does not ask. Words anywhere else in a reply
// ("this is not intended", "is this by design?", "acknowledged, will fix")
// do not dismiss, since a dismissed finding leaves the verdict. Disagreement
// ("I disagree") keeps the finding reported.
export function declinesFinding(reply: string): boolean {
  if (DISMISS.test(reply)) return true;
  const opening =
    reply
      .trim()
      .split(/(?<=[.!?])\s|\n/)[0]
      ?.trim() ?? "";
  return DECLINE.test(opening) && !opening.endsWith("?");
}

// The finding a thread of ocra's is about: its first comment is ocra's, with
// a marker, and nobody else edited it. An edited marker could point a
// reviewer's resolution or reply at another finding, or hide one.
export function findingOf(thread: PlatformThread, bot: Bot): string | undefined {
  const first = thread.comments[0];
  const fingerprint = first && FINDING_MARKER.exec(first.body)?.[1];
  if (!first || !fingerprint || !bot.is(first.author)) return undefined;
  return first.editor === undefined || bot.is(first.editor) ? fingerprint : undefined;
}

// What `ocra learn feedback` reads (ADR-0069): the findings someone with
// write access declined in their thread, with what they said: their decline,
// or their last reply in a thread a writer resolved. Any writer may, the
// author too, as with `@ocra remember`: nothing leaves the verdict here, and
// the words only become a learning through a pull request the team can
// require a person to review.
export async function declinedFindings(
  threads: readonly PlatformThread[],
  findings: readonly PriorFinding[],
  bot: Bot,
  canWrite: (login: string) => Promise<boolean>,
): Promise<NonNullable<ChangeRequest["declined"]>> {
  const known = new Map(findings.map((f) => [f.fingerprint, f]));
  const writer = async (login: string | undefined) =>
    login !== undefined && !bot.is(login) && (await canWrite(login));
  const declined: NonNullable<ChangeRequest["declined"]> = [];
  for (const thread of threads) {
    if (declined.length >= MAX_DECLINED) break;
    const fingerprint = findingOf(thread, bot);
    const finding = fingerprint === undefined ? undefined : known.get(fingerprint);
    if (!finding) continue;
    const said: { by: string; text: string; declines: boolean }[] = [];
    for (const r of thread.comments.slice(1)) {
      const own = r.editor === undefined || r.editor === r.author;
      const text = r.body.replace(DISMISS, "").trim();
      if (!own || text === "" || !(await writer(r.author))) continue;
      said.push({ by: r.author, text, declines: declinesFinding(r.body) });
    }
    const resolved = thread.resolved && (await writer(thread.resolvedBy));
    const reason = resolved ? said.at(-1) : said.findLast((s) => s.declines);
    if (!reason) continue;
    declined.push({
      by: reason.by,
      fingerprint: finding.fingerprint,
      title: finding.title,
      file: finding.file,
      reason: reason.text.slice(0, MAX_REASON),
    });
  }
  return declined;
}
