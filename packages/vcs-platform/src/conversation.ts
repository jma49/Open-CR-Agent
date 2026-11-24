import type { Mention, MentionRef } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core";
import { givesCommand } from "./commands.js";
import { safeMarkdown } from "./neutralize.js";
import type { Bot, PlatformDiscussion, ReviewPlatform } from "./platform.js";
import { safeLine } from "./render.js";
import { SUMMARY_MARKER } from "./state.js";

// `@ocra` as a word of its own, outside code: not part of an address
// (`me@ocra.dev`) or a longer name (`@ocra-bot`).
const MENTION = /(^|[^\w@`.])@ocra(?![\w-])/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm;
const CODE_SPAN = /`[^`\n]*`/g;
const REPLY_MARKER = (id: string) => `<!-- ocra:reply ${id} -->`;
const OCRA_MARKER = /<!-- ocra:/;
const MAX_QUOTE_CHARS = 200;

export interface ConversationRules {
  platform: Pick<ReviewPlatform, "discussion" | "reply">;
  bot(): Promise<Bot>;
  canWrite(login: string): Promise<boolean>;
}

// Who ocra answers (ADR-0048): someone with write access, in a comment
// nobody else edited, that mentions ocra outside code, once per comment.
// Anyone can comment on a public pull request, and each answer is a model
// call the account pays for.
export async function mentionOf(ref: MentionRef, rules: ConversationRules): Promise<Mention> {
  let discussion: PlatformDiscussion | undefined;
  try {
    discussion = await rules.platform.discussion(ref);
  } catch (error) {
    return ignored(`could not read the comment: ${errorMessage(error)}`);
  }
  if (!discussion) return ignored("the comment is not on this change request");
  const { comment } = discussion;
  const bot = await rules.bot();
  const by = comment.author;
  if (
    !by ||
    bot.is(by) ||
    OCRA_MARKER.test(comment.body) ||
    comment.body.includes(SUMMARY_MARKER)
  ) {
    return ignored("the comment is ocra's own");
  }
  const prose = comment.body.replace(FENCE, "").replace(CODE_SPAN, "");
  if (!MENTION.test(prose)) return ignored("the comment does not mention @ocra");
  if (givesCommand(prose)) return ignored("the comment gives ocra a command");
  if (comment.editor !== undefined && comment.editor !== by) {
    return ignored("someone other than its author edited the comment");
  }
  const marker = REPLY_MARKER(comment.id);
  if (discussion.later.some((c) => bot.is(c.author) && c.body.includes(marker))) {
    return ignored("ocra already answered the comment");
  }
  if (!(await rules.canWrite(by).catch(() => false))) {
    return ignored(`${by} has no write access, so ocra does not answer them`);
  }
  const question = comment.body.replace(new RegExp(MENTION.source, "gi"), "$1").trim();
  if (question === "") return ignored("the comment asks nothing");
  const found = discussion;
  return {
    asked: true,
    by,
    question,
    thread: found.earlier,
    ...(found.on ? { on: found.on } : {}),
    answer: (text) => rules.platform.reply(found, replyBody(found, by, question, text)),
  };
}

// The answer neutralized like a finding; a reply that is not in a thread
// quotes what it answers.
function replyBody(
  discussion: PlatformDiscussion,
  by: string,
  question: string,
  text: string,
): string {
  const quote =
    discussion.replyTo === undefined
      ? [`> @​${safeLine(by)}: ${safeLine(question.slice(0, MAX_QUOTE_CHARS))}`, ""]
      : [];
  return [
    REPLY_MARKER(discussion.comment.id),
    ...quote,
    safeMarkdown(text, { startsLine: true }),
  ].join("\n");
}

function ignored(reason: string): Mention {
  return { asked: false, reason };
}
