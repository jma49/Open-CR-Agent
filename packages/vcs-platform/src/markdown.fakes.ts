import { micromark, parse, postprocess, preprocess } from "micromark";
import { gfmTable, gfmTableHtml } from "micromark-extension-gfm-table";

// How a CommonMark parser with GitHub's tables reads a posted comment, for
// tests that check what it renders rather than how it is spelled. It knows
// no platform extension (GitLab's wikilinks and multiline blockquotes, math
// on both): those are checked here by their spelling, or by tests that
// assert the exact output.

const MARKUP = new Set(["htmlFlow", "htmlText", "autolink", "link", "image", "definition"]);

// What in the Markdown a platform would render as markup (raw HTML, a link,
// an image, a link reference definition), a mention or an address, or read
// as a command, or post as a committable suggestion; and what GitLab parses
// before Markdown's code: the fence of a multiline blockquote, a dollar sign
// of math, a bare carriage return.
export function problemsIn(markdown: string): string[] {
  const entered = postprocess(
    parse({ extensions: [gfmTable()] })
      .document()
      .write(preprocess()(markdown, undefined, true)),
  )
    .filter(([kind]) => kind === "enter")
    .map(([, token]) => token);
  const source = (t: (typeof entered)[number]) => markdown.slice(t.start.offset, t.end.offset);
  const inCode = new Set<number>();
  for (const t of entered.filter((t) => t.type === "codeFenced" || t.type === "codeIndented")) {
    for (let line = t.start.line; line <= t.end.line; line++) inCode.add(line);
  }
  const lines = markdown.split(/\r\n?|\n/).filter((_, i) => !inCode.has(i + 1));
  const text = textOutsideCode(markdown);
  return [
    ...new Set(entered.filter((t) => MARKUP.has(t.type)).map((t) => `${t.type}: ${source(t)}`)),
    ...(text.match(/@[\p{L}\p{N}_.-]+/gu) ?? []).map((m) => `mention: ${m}`),
    ...(text.match(/\S*(?::\/\/|www\.)\S*/gi) ?? []).map((a) => `address: ${a}`),
    ...lines.filter((line) => /^[ \t]*\//.test(line)).map((line) => `command: ${line}`),
    ...lines.filter((line) => />{3,}[ \t]*$/.test(line)).map((line) => `quote fence: ${line}`),
    ...entered
      .filter((t) => t.type === "data" && !inCode.has(t.start.line) && source(t).includes("$"))
      .map((t) => `dollar: ${source(t)}`),
    ...entered
      .filter((t) => t.type === "codeFencedFenceInfo" && /^suggestion/i.test(source(t)))
      .map((t) => `suggestion fence: ${source(t)}`),
    ...(markdown.includes("\r") ? ["carriage return"] : []),
  ];
}

// The rendered text a reader sees outside code, where both platforms look
// for mentions and addresses. Raw HTML is let through, as it is before a
// platform's sanitizer.
function textOutsideCode(markdown: string): string {
  const html = micromark(markdown, {
    allowDangerousHtml: true,
    allowDangerousProtocol: true,
    extensions: [gfmTable()],
    htmlExtensions: [gfmTableHtml()],
  });
  return html.replace(/<pre>[\s\S]*?<\/pre>|<code>[\s\S]*?<\/code>/g, " ");
}
