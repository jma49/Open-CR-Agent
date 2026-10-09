// Everything a model reads is either ocra's own text or data from the change
// under review: diffs, files, pull request text, paths, rules, guidelines,
// memory, tool results, and model output derived from any of them. Data must
// never be able to open or close one of ocra's sections and so pose as
// instructions or as another finding.
//
// - Sections are tagged `<ocra_NAME>`. Ordinary code does not use that
//   prefix, so HTML and XML in reviewed files reach the model unchanged.
// - Every `<ocra_` or `</ocra_` in data becomes `‹ocra_`, including
//   look-alike brackets and letters, compatibility forms, spaces, case and
//   invisible characters in between. A bracket that ends a piece of data
//   becomes `‹` too, so two pieces cannot form a tag where ocra joins them.
// - The rule is structural: a section's body is PromptText, which only
//   `data()` (neutralized) and `ocraText()` or `section()` (ocra's own)
//   produce, so a builder cannot embed raw text by accident.

declare const brand: unique symbol;
export type PromptText = string & { readonly [brand]: "PromptText" };

const SECTIONS = [
  "change_request",
  "title",
  "description",
  "changed_files",
  "repository_guidelines",
  "review_rules",
  "accepted_findings",
  "review_files",
  "file",
  "findings",
  "finding",
  "diff",
  "file_excerpt",
  "callers",
  "review_plan",
  "reply",
] as const;
export type SectionName = (typeof SECTIONS)[number];

// Characters a tokenizer may drop or a model may read past: whitespace,
// every default-ignorable code point (joiners, direction marks, variation
// selectors, tag characters, Hangul fillers) and other format characters.
const INVISIBLE = /^[\s\p{Default_Ignorable_Code_Point}\p{Cf}]$/u;
// `<` and what renders like it, in the text as written: the brackets whose
// compatibility form (NFKC) is one of these are listed too. `‹` is left out:
// it is what neutralized tags become.
const OPEN_BRACKET =
  /[<\u02c2\u1438\u16b2\u2329\u27e8\u276c\u276e\u2770\u29fc\u3008\ufe3f\ufe64\uff1c\u{1d236}]/gu;
// The rest of a tag is matched one code point at a time on its compatibility
// form, so fullwidth, mathematical, circled, small and Roman numeral letters
// read as the ASCII ones; the classes add look-alikes from other scripts.
const SLASH = /^[/\u2044\u2215\u2571\u29f8]$/u;
const PREFIX = [
  /^[o\u03bf\u043e\u0585\u1d0f]$/iu,
  /^[c\u03c2\u03f2\u0441\u1d04]$/iu,
  /^[r\u0280\u0433\u1d26]$/iu,
  /^[a\u0251\u03b1\u0430\u1d00]$/iu,
  /^_$/u,
];

export function data(text: string): PromptText {
  let out = "";
  let at = 0;
  for (const bracket of text.matchAll(OPEN_BRACKET)) {
    if (bracket.index < at) continue;
    const tag = tagAfter(text, bracket.index + bracket[0].length);
    if (tag === undefined) continue;
    out += text.slice(at, bracket.index);
    if (tag === "cut") {
      // The text ends inside a tag that the next piece of data, wherever
      // ocra joins two, could finish: the bracket alone is enough.
      out += "‹";
      at = bracket.index + bracket[0].length;
    } else {
      out += `‹${tag.slash ? "/" : ""}ocra_`;
      at = tag.end;
    }
  }
  return (out + text.slice(at)) as PromptText;
}

// Linear: a scan that fails stops at the first character no tag can hold,
// and the invisible run it crossed holds no bracket to start another.
function tagAfter(text: string, from: number): { end: number; slash: boolean } | "cut" | undefined {
  let at = skipInvisible(text, from);
  if (at === text.length) return "cut";
  const slash = SLASH.test(foldedAt(text, at));
  if (slash) at = skipInvisible(text, at + charLength(text, at));
  for (const letter of PREFIX) {
    if (letter !== PREFIX[0]) at = skipInvisible(text, at);
    if (at === text.length) return "cut";
    if (!letter.test(foldedAt(text, at))) return undefined;
    at += charLength(text, at);
  }
  return { end: at, slash };
}

function skipInvisible(text: string, from: number): number {
  let at = from;
  while (at < text.length && INVISIBLE.test(String.fromCodePoint(text.codePointAt(at) ?? 0))) {
    at += charLength(text, at);
  }
  return at;
}

function charLength(text: string, at: number): number {
  return (text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1;
}

function foldedAt(text: string, at: number): string {
  const char = String.fromCodePoint(text.codePointAt(at) ?? 0);
  const folded = char.normalize("NFKC");
  return [...folded].length === 1 ? folded : char;
}

// For text ocra itself writes: instructions and labels, never data.
export function ocraText(text: string): PromptText {
  return text as PromptText;
}

// Attribute values are data too, and must also not end the attribute or the
// opening tag, or add a line.
export function attribute(value: string | number): string {
  return data(String(value))
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\r\n]+/g, " ");
}

export function section(
  name: SectionName,
  body: PromptText | readonly PromptText[],
  attributes: Readonly<Record<string, string | number>> = {},
): PromptText {
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${attribute(value)}"`)
    .join("");
  const content = typeof body === "string" ? body : body.join("\n");
  return `<ocra_${name}${attrs}>\n${content}\n</ocra_${name}>` as PromptText;
}

export function join(parts: readonly PromptText[], separator = "\n"): PromptText {
  return parts.join(separator) as PromptText;
}

// A label written by ocra followed by data, such as "Title: <data>".
export function labelled(label: string, value: string, separator = " "): PromptText {
  return `${label}${separator}${data(value)}` as PromptText;
}

export function truncated(text: string, max: number): PromptText {
  return text.length > max ? join([data(text.slice(0, max)), ocraText("[truncated]")]) : data(text);
}

// File names may contain newlines (git quotes and decodes them), which in a
// one-line field would start a line of their own in the prompt.
export function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ");
}
