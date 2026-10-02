// Model text is untrusted: it may not close our markup, mention people,
// pull in images, spell one of ocra's commands (`/ocra …`, which would count
// if ocra posted as a person with write access), start a line with a slash
// (GitLab runs a line such as `/merge` or `/approve` in a comment as a quick
// action, with the rights of the token that posted it), or become a link at
// all. A pull request can plant an address for a reviewer to repeat (the
// adversarial probe saw one), and a bot comment lends it credibility.
// Character references get a zero-width space after their `&` and stay as
// typed, since both platforms look for mentions after decoding them
// (`&#64;all`); unlike `&amp;`, it keeps `&lt;` quoted in code readable.
// Every `@` gets one too, which no mention survives (GitLab usernames may
// start with `_` or `.`), nor an email address. Inline links lose their `](`,
// and every `]:` is escaped, so no link reference definition (`[1]: https://…`)
// can form, at line start or inside a blockquote or list item, and no
// reference-style link (`[x][1]`, `[x][]`, `[1]`) has anything to resolve to.
// Addresses of every scheme get a zero-width space after the colon (GitLab
// links `smb://` and `vscode://` too), and `www.` one before its dot, so they
// read the same and stay text.
//
// Code is left as written, so that a reader who copies what a finding quotes
// gets the code and not our zero-width spaces: nothing inside a code span
// renders as a mention, link, image or HTML on either platform, and GitLab's
// quick-action extractor skips code blocks and inline code. Code is what
// CommonMark would render as code where the text is posted, and only what
// both platforms agree on: a backtick fence that starts a line of the posted
// comment and is closed, and an inline backtick run closed on the same line by
// a run of the same length. A `~~~` fence, an indented block and a span across
// lines keep the text rules. An unbalanced backtick run is text; it is escaped
// so that it cannot pair with a backtick in a later piece of the same comment
// and open a span that we did not neutralize. Two things stay neutralized in
// code because ocra reads them from the raw body, not the rendering: an HTML
// comment opener (ocra's markers) and `/ocra` (its commands).
const CHARACTER_REFERENCE = /&(?=#\d{1,7};|#[xX][\da-fA-F]{1,6};|[A-Za-z][A-Za-z\d]{1,31};)/g;
const FENCE_OPENER = /^ {0,3}(`{3,})[^`]*$/;
// A backtick string; `\`` is an escaped backtick, so never part of one.
const BACKTICK_RUN = /\\`|`+/g;

export interface Placement {
  // True when the text starts a line of the posted comment, so that a fence
  // on its first line is a fence. Text placed after other words on a line
  // (a title, a reason, a suggestion after its label) starts none.
  startsLine?: boolean;
}

export function safeMarkdown(text: string, { startsLine = false }: Placement = {}): string {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const opener = i > 0 || startsLine ? FENCE_OPENER.exec(line) : null;
    const end = opener ? closingFence(lines, i + 1, (opener[1] as string).length) : -1;
    if (end === -1) {
      out.push(neutralizeInline(line));
      continue;
    }
    for (let j = i; j <= end; j++) out.push(neutralizeCode(lines[j] as string));
    i = end;
  }
  return out.join("\n");
}

function closingFence(lines: readonly string[], from: number, length: number): number {
  const closer = new RegExp(`^ {0,3}\`{${length},}[ \\t]*$`);
  for (let j = from; j < lines.length; j++) if (closer.test(lines[j] as string)) return j;
  return -1;
}

// One line: code spans per CommonMark's pairing of backtick strings, the
// text between them neutralized, unpaired strings escaped.
function neutralizeInline(line: string): string {
  const runs = [...line.matchAll(BACKTICK_RUN)]
    .filter((m) => m[0] !== "\\`")
    .map((m) => ({ start: m.index, end: m.index + m[0].length }));
  const out: string[] = [];
  let cursor = 0;
  let text = "";
  const flushText = (upTo: number) => {
    text += line.slice(cursor, upTo);
    cursor = upTo;
  };
  const emitText = () => {
    if (text !== "") out.push(neutralizeText(text, out.length === 0));
    text = "";
  };
  for (let k = 0; k < runs.length; k++) {
    const open = runs[k] as { start: number; end: number };
    const length = open.end - open.start;
    const closeAt = runs.findIndex((r, j) => j > k && r.end - r.start === length);
    if (closeAt === -1) {
      flushText(open.start);
      text += "\\`".repeat(length);
      cursor = open.end;
      continue;
    }
    const close = runs[closeAt] as { start: number; end: number };
    flushText(open.start);
    emitText();
    out.push(neutralizeCode(line.slice(open.start, close.end)));
    cursor = close.end;
    k = closeAt;
  }
  flushText(line.length);
  emitText();
  return out.join("");
}

function neutralizeText(text: string, atLineStart: boolean): string {
  const safe = text
    .replace(CHARACTER_REFERENCE, "&​")
    .replaceAll("<!--", "&lt;!--")
    .replace(/<\/?[a-zA-Z][^>]*>/g, (tag) => tag.replaceAll("<", "&lt;"))
    .replaceAll("@", "@​")
    .replace(/!\[/g, "!​[")
    .replace(/\/(?=ocra)/gi, "/​")
    .replace(/:(?=\/\/)/g, ":​")
    .replace(/\bwww(?=\.)/gi, "www​")
    .replaceAll("](", "]\\(")
    .replaceAll("]:", "]\\:");
  return atLineStart ? safe.replace(/^([ \t]*)\//, "$1​/") : safe;
}

function neutralizeCode(code: string): string {
  return code.replaceAll("<!--", "<!​--").replace(/\/(?=ocra)/gi, "/​");
}
