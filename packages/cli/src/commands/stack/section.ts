import { safeMarkdown } from "@open-cr-agent/vcs-platform/internal";

const START = "<!-- ocra:stack -->";
const END = "<!-- /ocra:stack -->";

export interface SectionEntry {
  number: number;
  title: string;
}

// The stack's list in a change request's description, bottom to top, this
// one in bold; `sigil` is how the platform links a number (# or !).
export function stackSection(
  entries: readonly SectionEntry[],
  current: number,
  sigil: "#" | "!",
): string {
  const lines = entries.map((e, i) => {
    const item = `${sigil}${e.number} ${safeMarkdown(e.title)}`;
    return `${i + 1}. ${e.number === current ? `**${item}** (this one)` : item}`;
  });
  return [START, "**Stack**, bottom to top:", "", ...lines, END].join("\n");
}

// The description with its stack section replaced, or added at its end;
// what the author wrote outside the markers is kept as it is.
export function withStackSection(body: string, section: string): string {
  const start = body.indexOf(START);
  const end = body.indexOf(END, start);
  if (start >= 0 && end >= 0) {
    return `${body.slice(0, start)}${section}${body.slice(end + END.length)}`;
  }
  return body.trim() ? `${body.trimEnd()}\n\n${section}` : section;
}
