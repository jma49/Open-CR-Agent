import { parse, postprocess, preprocess } from "micromark";
import { gfmTable } from "micromark-extension-gfm-table";

// Model text is untrusted: it may not close our markup, embed HTML or images,
// mention people, spell one of ocra's commands (`/ocra …`, which would count
// if ocra posted as a person with write access), start a line with a slash
// (GitLab runs a line such as `/merge` or `/approve` in a comment as a quick
// action, with the rights of the token that posted it), or become a link at
// all. A pull request can plant an address for a reviewer to repeat (the
// adversarial probe saw one), and a bot comment lends it credibility.
//
// Code is left as written, so that a reader who copies what a finding quotes
// gets the code and not our zero-width spaces: nothing inside a code span
// renders as a mention, link, image or HTML on either platform, and GitLab's
// quick-action extractor skips code blocks and inline code. What is code is
// decided by a CommonMark parse with GitHub's tables (a cell boundary splits
// a code span), of the text where it is posted; rules applied line by line
// disagreed with the platforms on tags across lines, backslashes before
// backticks, bare carriage returns and HTML blocks. Only a closed backtick
// fence and a code span on one line stay code. A `~~~` fence, an indented
// block, a span across lines and an unclosed fence (which would run on over
// ocra's own text) get the text rules. Two things stay neutralized in code
// because ocra reads them from the raw body, not the rendering: an HTML
// comment opener (ocra's markers) and `/ocra` (its commands).
//
// The text rules leave no syntax that binds tighter than a code span, so the
// code the parse found is the code in the posted comment: every `<` becomes
// `&lt;` (no tag, autolink or HTML block), and every unescaped backtick (no
// span here or later in the comment) and `$` (math, on both platforms) is
// escaped. Three or more `>` ending a line, which open or close a GitLab
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

export interface Placement {
  // True when the text starts a line of the posted comment, so that a fence
  // on its first line is a fence. Text placed after other words on a line
  // (a title, a reason, a suggestion after its label) starts none.
  startsLine?: boolean;
}

export function safeMarkdown(text: string, { startsLine = false }: Placement = {}): string {
  // A bare carriage return ends a line in CommonMark too.
  const source = text.replace(/\r\n?/g, "\n");
  const out: string[] = [];
  let cursor = 0;
  for (const code of codeIn(source, startsLine)) {
    out.push(neutralizeText(source, cursor, code.start, startsLine));
    out.push(neutralizeCode(source.slice(code.start, code.end)));
    cursor = code.end;
  }
  out.push(neutralizeText(source, cursor, source.length, startsLine));
  return out.join("");
}

interface Span {
  start: number;
  end: number;
}

function codeIn(source: string, startsLine: boolean): Span[] {
  // What precedes the text where it is posted: a blank line, or words on its
  // first line. Either also keeps a leading byte order mark a character, as
  // it is in the middle of a comment, where the parser would drop it.
  const before = startsLine ? "\n" : "x";
  const document = parse({ extensions: [gfmTable()] }).document();
  const events = postprocess(document.write(preprocess()(before + source, undefined, true)));
  const code: Span[] = [];
  let fences = 0;
  for (const [kind, token] of events) {
    const span = {
      start: token.start.offset - before.length,
      end: token.end.offset - before.length,
    };
    if (token.type === "codeFencedFence" && kind === "enter") fences++;
    else if (token.type === "codeFenced" && kind === "enter") fences = 0;
    else if (token.type === "codeFenced" && fences === 2 && source[span.start] === "`") {
      code.push(span);
    } else if (token.type === "codeText" && kind === "enter") {
      if (!source.slice(span.start, span.end).includes("\n")) code.push(span);
    }
  }
  return code;
}

function neutralizeText(source: string, start: number, end: number, startsLine: boolean): string {
  if (start === end) return "";
  const lines = escapeSyntax(source.slice(start, end).replace(CHARACTER_REFERENCE, "&\u200b"))
    .replaceAll("@", "@\u200b")
    .replaceAll("![", "!\u200b[")
    .replace(/\/(?=ocra)/gi, "/\u200b")
    .replace(/:(?=\\?\/\\?\/)/g, ":\u200b")
    .replace(/www(?=\\?\.)/gi, "www\u200b")
    .replaceAll("](", "]\\(")
    .replaceAll("]:", "]\\:")
    .split("\n");
  const startsALine = start === 0 ? startsLine : source[start - 1] === "\n";
  const endsALine = end === source.length || source[end] === "\n";
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
