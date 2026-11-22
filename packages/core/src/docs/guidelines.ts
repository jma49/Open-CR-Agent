// The repository's guidelines (AGENTS.md) as whole sections, and which of
// them a review task is given (ADR-0058). A section is never cut: one that
// does not fit the budget is left out and listed by its heading.

export const GUIDELINE_SCOPES = ["all", "matched", "reviewer"] as const;
// all: every section, to every reviewer (the default). matched: to every
// reviewer, the sections that apply to the bundle's files. reviewer: only to
// the reviewers that check the guidelines themselves.
export type GuidelineScope = (typeof GUIDELINE_SCOPES)[number];

export interface GuidelineSection {
  heading: string;
  // The section as written, its heading line included: the sections joined
  // are the document again.
  raw: string;
  // Repository paths the section is about, as prefixes; empty for a section
  // that applies everywhere.
  scope: string[];
}

export interface GuidelineSelection {
  given: GuidelineSection[];
  // Sections that apply but did not fit, and those about other files.
  left: GuidelineSection[];
}

// A section starts at a heading of level 1 to 3 outside a code fence; what
// precedes the first heading is a section of its own. A section takes the
// scope of the heading above it when its own heading names no path.
export function guidelineSections(text: string): GuidelineSection[] {
  const sections: GuidelineSection[] = [];
  const scopes: string[][] = [];
  let heading = "";
  let scope: string[] = [];
  let lines: string[] = [];
  let fenced = false;
  const flush = () => {
    if (lines.length > 0) sections.push({ heading, raw: lines.join("\n"), scope });
  };
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) {
      flush();
      const level = match[1]?.length ?? 1;
      heading = match[2] ?? "";
      const own = pathsIn(heading);
      // The scope each open heading level gives the sections below it.
      while (scopes.length < level - 1) scopes.push(scopes.at(-1) ?? []);
      scopes.length = level - 1;
      scope = own.length > 0 ? own : (scopes.at(-1) ?? []);
      scopes.push(scope);
      lines = [];
    }
    lines.push(line);
  }
  flush();
  return sections;
}

// A section is about one part of the repository only when its heading says
// so with a path ("## web/", "### `packages/core`"). Paths in a section's
// text are mostly examples of a rule that applies everywhere, so they never
// scope it: recall over tokens.
const PATH_TOKEN = /(?<![\w.:/@-])((?:[\w.-]+\/)+[\w.-]*)(?![\w/])/g;

function pathsIn(heading: string): string[] {
  return [...heading.matchAll(PATH_TOKEN)]
    .map((m) => (m[1] ?? "").replace(/\/$/, ""))
    .filter((p) => p !== "" && !p.startsWith("../"));
}

function applies(section: GuidelineSection, files: readonly string[]): boolean {
  if (section.scope.length === 0) return true;
  return section.scope.some((scope) => {
    const s = scope.toLowerCase();
    return files.some((file) => {
      const f = file.toLowerCase();
      return f === s || f.startsWith(`${s}/`) || f.endsWith(`/${s}`);
    });
  });
}

// In the document's order, every section that applies and still fits.
export function selectGuidelines(
  sections: readonly GuidelineSection[],
  files: readonly string[] | "all",
  maxChars: number,
): GuidelineSelection {
  const given: GuidelineSection[] = [];
  const left: GuidelineSection[] = [];
  let used = 0;
  for (const section of sections) {
    const cost = section.raw.length + (given.length > 0 ? 1 : 0);
    if ((files === "all" || applies(section, files)) && used + cost <= maxChars) {
      given.push(section);
      used += cost;
    } else {
      left.push(section);
    }
  }
  return { given, left };
}

export const MAX_GUIDELINES_CHARS = 20_000;

export interface TaskGuidelines {
  text: string;
  // Headings of the sections left out, best read with the file tool.
  left: string[];
}

// What one review task is given. A reviewer that checks the guidelines
// themselves gets every section whatever the scope.
export function guidelinesForTask(
  sections: readonly GuidelineSection[],
  scope: GuidelineScope,
  files: readonly string[],
  checksGuidelines: boolean,
): TaskGuidelines | undefined {
  if (sections.length === 0) return undefined;
  if (scope === "reviewer" && !checksGuidelines) return undefined;
  const wanted = scope === "matched" && !checksGuidelines ? files : "all";
  const { given, left } = selectGuidelines(sections, wanted, MAX_GUIDELINES_CHARS);
  // When even the first section that applies is larger than the whole
  // budget, the prompt cuts and marks it, rather than leave it all out.
  if (given.length === 0) {
    const applicable = wanted === "all" ? sections : sections.filter((s) => applies(s, wanted));
    const whole = applicable.map((s) => s.raw).join("\n");
    return whole.trim() ? { text: whole, left: [] } : undefined;
  }
  return { text: given.map((s) => s.raw).join("\n"), left: left.map((s) => s.heading) };
}
