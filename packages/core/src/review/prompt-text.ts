// Everything a model reads is either ocra's own text or data from the change
// under review: diffs, files, pull request text, paths, rules, guidelines,
// memory, tool results, and model output derived from any of them. Data must
// never be able to open or close one of ocra's sections and so pose as
// instructions or as another finding.
//
// - Sections are tagged `<ocra_NAME>`. Ordinary code does not use that
//   prefix, so HTML and XML in reviewed files reach the model unchanged.
// - Every `<ocra_` or `</ocra_` in data becomes `‹ocra_`, including
//   look-alike brackets, spaces, case and invisible characters in between.
// - The rule is structural: a section's body is PromptText, which only
//   `data()` (neutralized) and `ocraText()` or `section()` (ocra's own)
//   produce, so a builder cannot embed raw text by accident.

declare const brand: unique symbol;
export type PromptText = string & { readonly [brand]: "PromptText" };

export const SECTIONS = [
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

// Characters a tokenizer may drop or a model may read past: whitespace, soft
// hyphen, joiners, direction marks and overrides, variation selectors.
const INVISIBLE =
  "[\\s\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufe00-\\ufe0f\\ufeff]*";
// `<` and the characters that render like it. `‹` is left out: it is what
// neutralized tags become.
const OPEN_BRACKET = "[<\\u02c2\\u2329\\u27e8\\u3008\\ufe64\\uff1c]";
// Fullwidth, Cyrillic and Greek letters that render like the Latin ones.
const PREFIX = [
  "[oｏ\u043e\u03bf]",
  "[cｃ\u0441\u03f2]",
  "[rｒ]",
  "[aａ\u0430\u03b1]",
  "[_＿]",
].join(INVISIBLE);
const SLASH = "[/\\u2044\\u2215\\uff0f]";
// One run of invisible characters before an optional slash, never two
// adjacent ones: two let a failed match retry every split of a long run,
// and 100k spaces after a "<" took 16 s.
const TAG = new RegExp(`${OPEN_BRACKET}${INVISIBLE}(?:(${SLASH})${INVISIBLE})?${PREFIX}`, "giu");

export function data(text: string): PromptText {
  return text.replace(TAG, (_, slash?: string) => `‹${slash ? "/" : ""}ocra_`) as PromptText;
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
