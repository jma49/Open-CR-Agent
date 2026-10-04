import type { Finding, LineRange } from "@open-cr-agent/core";
import { isUnsafeCodePoint } from "@open-cr-agent/core/internal";

// The info string of a fenced block the platform offers as a committable
// change of the lines `range`, where the comment is anchored, or undefined
// when it offers none for that range.
export type SuggestionFence = (range: LineRange) => string | undefined;

// GitHub's comment spans its lines, so its suggestion replaces them.
export const githubSuggestion: SuggestionFence = () => "suggestion";

// GitLab's thread sits on the range's last line; the suggestion reaches the
// lines above it, at most 100.
const GITLAB_MAX_LINES_ABOVE = 100;
export const gitlabSuggestion: SuggestionFence = ({ start, end }) =>
  end - start > GITLAB_MAX_LINES_ABOVE ? undefined : `suggestion:-${end - start}+0`;

const MAX_REPLACEMENT_CHARS = 20_000;
// What safeMarkdown rewrites even in code, because ocra reads it from the raw
// comment: its markers and its commands.
const REWRITTEN_IN_CODE = /<!--|\/ocra/i;

// A finding's fix as a committable suggestion (ADR-0029): only for a fix of
// exactly the lines its inline comment is on, and only when the replacement
// can be posted as written. Neutralizing it like other model text would
// change the code a click commits, so anything that would need it gets no
// block. The fence is longer than any backtick run inside, so the
// replacement cannot close it; inside a code block nothing renders as a
// mention, link or HTML, and GitLab runs no quick action.
export function suggestionBlock(f: Finding, fence: SuggestionFence): string | undefined {
  const { fix, lineRange } = f;
  if (!fix || !lineRange || !f.anchor.inDiff) return undefined;
  if (fix.startLine !== lineRange.start || fix.endLine !== lineRange.end) return undefined;
  if (!postable(fix.replacement)) return undefined;
  const info = fence(lineRange);
  if (info === undefined) return undefined;
  const longestRun = Math.max(0, ...(fix.replacement.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return [`${ticks}${info}`, ...(fix.replacement === "" ? [] : [fix.replacement]), ticks].join(
    "\n",
  );
}

// Carriage returns and controls are refused rather than stripped, like
// everything else that would change the code.
function postable(replacement: string): boolean {
  if (replacement.length > MAX_REPLACEMENT_CHARS || REWRITTEN_IN_CODE.test(replacement)) {
    return false;
  }
  for (const char of replacement) {
    if (isUnsafeCodePoint(char.codePointAt(0) as number)) return false;
  }
  return true;
}
