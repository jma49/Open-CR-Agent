import { parse, postprocess, preprocess } from "micromark";
import { gfmTable } from "micromark-extension-gfm-table";

// Model text is untrusted: it may not close our markup, embed HTML or images,
// mention people, spell one of ocra's commands (`/ocra …`, which would count
// if ocra posted as a person with write access), start a line with a slash
// (GitLab runs a line such as `/merge` or `/approve` in a comment as a quick
// action, with the rights of the token that posted it), become a link at
// all, or post a committable suggestion, which ocra posts only for a fix that
// passes ADR-0029's checks. A pull request can plant an address for a
// reviewer to repeat (the adversarial probe saw one), and a bot comment
// lends it credibility.
//
// Code is left as written, so that a reader who copies what a finding quotes
// gets the code and not our zero-width spaces: nothing inside code renders as
// a mention, link, image or HTML on either platform, and GitLab's
// quick-action extractor skips code blocks and inline code. What is code is
// decided by a CommonMark parse with GitHub's tables (a cell boundary splits
// a code span), of the text where it is posted; rules applied line by line
// disagreed with the platforms on tags across lines, backslashes before
// backticks, bare carriage returns and HTML blocks. Code is a closed backtick
// fence, a code span on one line, and, in text that starts a line, an
// indented block after a blank line (after other text, or after an unclosed
// fence, which is escaped, it could continue a paragraph or a list item once
// posted). A `~~~` fence, a span across lines and an unclosed fence (which
// would run on over ocra's own text) get the text rules. In code, three
// things stay neutralized because ocra reads them from the raw body or they
// post more than code: an HTML comment opener (ocra's markers), `/ocra` (its
// commands) and a fence's `suggestion` info string.
//
// The text rules leave no syntax that binds tighter than a code span, so the
// code the parse found is the code in the posted comment. The parse leaves
// out what they break (HTML, autolinks, links; and emphasis, which cannot
// change what is code and is slow to resolve on some input), but not a link
// reference definition, whose `]:` may be in what would be a code span.
// Every `<` becomes `&lt;` (no tag, autolink or HTML block), and every
// unescaped backtick (no span here or later in the comment) and `$` (math, on
// both platforms) is escaped. A `[[` gets a zero-width space, as GitLab links
// any target of a wikilink, and so does a `~~~` fence's `suggestion` info
// string. Three or more `>` ending a line, which open or close a GitLab
// multiline blockquote around whatever follows, are spaced out, which
// CommonMark reads the same.
//
// Character references get a zero-width space after their `&` and stay as
// typed, since both platforms look for mentions after decoding them
// (`&#64;all`). Every `@` gets one too, which no mention survives (GitLab
// usernames may start with `_` or `.`), nor an email address. Inline links
// lose their `](`, and every `]:` is escaped, so no link reference definition
// (`[1]: https://…`) can form and no reference-style link (`[x][1]`, `[1]`)
// has anything to resolve to. Addresses of every scheme get a zero-width
// space after the colon (GitLab links `smb://` and `vscode://` too, in the
// rendered text, so also with escaped slashes), and `www.` one before its
// dot, so they read the same and stay text.
const CHARACTER_REFERENCE = /&(?=#\d{1,7};|#[xX][\da-fA-F]{1,6};|[A-Za-z][A-Za-z\d]{1,31};)/g;
const ASCII_PUNCTUATION = /^[!-/:-@[-`{-~]$/;
const ESCAPED = new Map([
  ["`", "\\`"],
  ["$", "\\$"],
  ["<", "&lt;"],
]);
const ABSENT = {
  disable: {
    null: [
      "attention",
      "autolink",
      "htmlFlow",
      "htmlText",
      "labelEnd",
      "labelStartImage",
      "labelStartLink",
    ],
  },
};
// An info string that names a suggestion, or may once its escapes and
// character references are decoded: any with `&` or `\` matches, which breaks
// some that would not decode to one, on purpose. In text, where only a `~~~`
// fence can open and references are broken, its spelling is enough.
const SUGGESTION_INFO = /^suggestion|[&\\]/i;
// The parser's work grows with the square of some of what text can hold:
// nested containers on a line, which it rescans at every level, and lines of
// a paragraph or of setext headings. Text is cut at GitHub's limit on a
// comment and at a number of lines no finding needs, and a line nests at most
// MAX_DEPTH containers; after them, a zero-width space makes the rest text.
const MAX_CHARS = 65_536;
const MAX_LINES = 2_000;
const MAX_DEPTH = 16;
const CONTAINER_MARKER = /[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))/y;

export interface Placement {
  // True when the text starts a line of the posted comment, so that a fence
  // on its first line is a fence. Text placed after other words on a line
  // (a title, a reason, a suggestion after its label) starts none.
  startsLine?: boolean;
}

export function safeMarkdown(text: string, { startsLine = false }: Placement = {}): string {
  // A bare carriage return ends a line in CommonMark too.
  const source = bounded(text.replace(/\r\n?/g, "\n")).split("\n").map(shallow).join("\n");
  const textBetween = (start: number, end: number) =>
    neutralizeText(
      source.slice(start, end),
      start === 0 ? startsLine : source[start - 1] === "\n",
      end === source.length || source[end] === "\n",
    );
  const out: string[] = [];
  let cursor = 0;
  for (const { start, end, info } of codeIn(source, startsLine)) {
    if (start > cursor) out.push(textBetween(cursor, start));
    const code =
      info === undefined
        ? source.slice(start, end)
        : `${source.slice(start, info)}\u200b${source.slice(info, end)}`;
    out.push(neutralizeCode(code));
    cursor = end;
  }
  if (source.length > cursor) out.push(textBetween(cursor, source.length));
  return out.join("");
}

function bounded(text: string): string {
  let cut = Math.min(text.length, MAX_CHARS);
  let lineEnd = -1;
  for (let line = 0; line < MAX_LINES && lineEnd < cut; line++) {
    lineEnd = text.indexOf("\n", lineEnd + 1);
    if (lineEnd === -1) break;
  }
  if (lineEnd !== -1 && lineEnd < cut) cut = lineEnd;
  if (cut === text.length) return text;
  if (/[\uD800-\uDBFF]/.test(text.charAt(cut - 1))) cut--;
  return `${text.slice(0, cut)} …(truncated)`;
}

function shallow(line: string): string {
  CONTAINER_MARKER.lastIndex = 0;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (!CONTAINER_MARKER.test(line)) return line;
  }
  const at = CONTAINER_MARKER.lastIndex;
  if (!CONTAINER_MARKER.test(line)) return line;
  const deeper = at + (/^[ \t]*/.exec(line.slice(at))?.[0].length ?? 0);
  return `${line.slice(0, deeper)}\u200b${line.slice(deeper)}`;
}

interface Code {
  start: number;
  end: number;
  // Where a fence's info string that names a suggestion starts.
  info?: number;
}

function codeIn(source: string, startsLine: boolean): Code[] {
  // What precedes the text where it is posted: a blank line, or words on its
  // first line. Either also keeps a leading byte order mark a character, as
  // it is in the middle of a comment, where the parser would drop it.
  const before = startsLine ? "\n" : "x";
  const text = before + source;
  const document = parse({ extensions: [gfmTable(), ABSENT] }).document();
  const events = postprocess(document.write(preprocess()(text, undefined, true)));
  const code: Code[] = [];
  let fences = 0;
  let info: number | undefined;
  // An unclosed backtick fence is escaped into a paragraph, which can
  // continue its list item past a blank line onto an indented block.
  let escapedFence = false;
  for (const [kind, token] of events) {
    const start = token.start.offset - before.length;
    const end = token.end.offset - before.length;
    const raw = source.slice(start, end);
    if (token.type === "codeFenced" && kind === "enter") {
      fences = 0;
      info = undefined;
    } else if (token.type === "codeFencedFence" && kind === "enter") fences++;
    else if (token.type === "codeFencedFenceInfo" && kind === "enter") {
      if (SUGGESTION_INFO.test(raw)) info = start;
    } else if (token.type === "codeFenced" && raw.startsWith("`")) {
      if (fences < 2) escapedFence = true;
      else code.push(info === undefined ? { start, end } : { start, end, info });
    } else if (token.type === "codeText" && kind === "enter") {
      if (!raw.includes("\n")) code.push({ start, end });
    } else if (token.type === "codeIndented" && kind === "enter") {
      if (startsLine && !escapedFence && afterBlankLine(text, token.start.offset)) {
        code.push({ start, end });
      }
    }
  }
  return code;
}

function afterBlankLine(text: string, offset: number): boolean {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  if (lineStart === 0) return false;
  const previousStart = lineStart >= 2 ? text.lastIndexOf("\n", lineStart - 2) + 1 : 0;
  return /^[ \t]*$/.test(text.slice(previousStart, lineStart - 1));
}

function neutralizeText(text: string, startsALine: boolean, endsALine: boolean): string {
  const lines = escapeSyntax(text.replace(CHARACTER_REFERENCE, "&\u200b"))
    .replaceAll("@", "@\u200b")
    .replaceAll("![", "!\u200b[")
    .replace(/\[(?=\[)/g, "[\u200b")
    .replace(/~{3,}[ \t]*(?=suggestion)/gi, "$&\u200b")
    .replace(/\/(?=ocra)/gi, "/\u200b")
    .replace(/:(?=\\?\/\\?\/)/g, ":\u200b")
    .replace(/www(?=\\?\.)/gi, "www\u200b")
    .replaceAll("](", "]\\(")
    .replaceAll("]:", "]\\:")
    .split("\n");
  return lines
    .map((line, i) => {
      let safe = line;
      if (i > 0 || startsALine) safe = safe.replace(/^([ \t]*)\//, "$1\u200b/");
      if (i < lines.length - 1 || endsALine) {
        safe = safe.replace(/>{3,}(?=[ \t]*$)/, (run) => [...run].join(" "));
      }
      return safe;
    })
    .join("\n");
}

// What could open a construct that binds tighter than a code span, escaped;
// what is escaped already stays as it is.
function escapeSyntax(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (char === "\\" && ASCII_PUNCTUATION.test(next)) {
      out += char + next;
      i++;
    } else {
      out += ESCAPED.get(char) ?? char;
    }
  }
  return out;
}

function neutralizeCode(code: string): string {
  return code.replaceAll("<!--", "<!\u200b--").replace(/\/(?=ocra)/gi, "/\u200b");
}
