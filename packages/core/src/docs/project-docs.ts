// The team's design documents (ADR-0052), as the caller read them from the
// trusted revision, and the sections of them a bundle's files are named in.
export interface ProjectDoc {
  path: string;
  text: string;
}

export interface DocSection {
  path: string;
  heading: string;
  text: string;
  // Position among all sections, for a stable order between equal scores.
  order: number;
}

export interface BundleSections {
  given: DocSection[];
  // Matching sections past the limit, best first: listed by heading only.
  more: DocSection[];
}

export const PROJECT_DOC_LIMITS = {
  given: 3,
  listed: 10,
  sectionChars: 3_000,
} as const;

// A section starts at a heading of level 1 to 3 outside a code fence.
export function docSections(docs: readonly ProjectDoc[]): DocSection[] {
  const sections: DocSection[] = [];
  for (const doc of docs) {
    let heading = doc.path;
    let lines: string[] = [];
    let fenced = false;
    const flush = () => {
      const text = lines.join("\n").trim();
      if (text) sections.push({ path: doc.path, heading, text, order: sections.length });
    };
    for (const line of doc.text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const title = fenced ? undefined : /^#{1,3}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
      if (title) {
        flush();
        heading = title;
        lines = [];
      } else {
        lines.push(line);
      }
    }
    flush();
  }
  return sections;
}

const GENERIC_DIRS = new Set([
  "src",
  "lib",
  "app",
  "apps",
  "test",
  "tests",
  "packages",
  "pkg",
  "cmd",
  "internal",
  "docs",
]);

// How strongly a section names a file: its path, its name, or its directory.
function namesOf(path: string): { token: string; weight: number }[] {
  const lower = path.toLowerCase();
  const slash = lower.lastIndexOf("/");
  const name = lower.slice(slash + 1);
  const dir = slash > 0 ? lower.slice(0, slash) : "";
  const names = [{ token: lower, weight: 3 }];
  if (name.length >= 4 && name !== lower) names.push({ token: name, weight: 2 });
  const last = dir.slice(dir.lastIndexOf("/") + 1);
  if (dir.includes("/")) names.push({ token: dir, weight: 1 });
  else if (last.length >= 4 && !GENERIC_DIRS.has(last)) names.push({ token: last, weight: 1 });
  return names;
}

function mentions(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w./-])${escaped}(?![\\w-])`).test(text);
}

// The sections that name the bundle's files, most strongly first; nothing is
// searched beyond the documents the team listed.
export function sectionsFor(
  sections: readonly DocSection[],
  files: readonly string[],
): BundleSections {
  const names = files.map(namesOf);
  const scored = sections
    .map((section) => {
      const text = `${section.heading}\n${section.text}`.toLowerCase();
      const score = names.reduce((sum, ofFile) => {
        const hit = ofFile.find((n) => mentions(text, n.token));
        return sum + (hit?.weight ?? 0);
      }, 0);
      return { section, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.section.order - b.section.order)
    .map((s) => s.section);
  return {
    given: scored.slice(0, PROJECT_DOC_LIMITS.given),
    more: scored.slice(
      PROJECT_DOC_LIMITS.given,
      PROJECT_DOC_LIMITS.given + PROJECT_DOC_LIMITS.listed,
    ),
  };
}

// A section some review task was given, for the report.
export interface ProjectDocUse {
  path: string;
  heading: string;
  bundles: string[];
}

export function projectDocUses(
  sections: readonly DocSection[],
  bundles: readonly { label: string; files: readonly string[] }[],
): ProjectDocUse[] {
  const uses = new Map<DocSection, ProjectDocUse>();
  for (const bundle of bundles) {
    for (const section of sectionsFor(sections, bundle.files).given) {
      const use = uses.get(section) ?? {
        path: section.path,
        heading: section.heading,
        bundles: [],
      };
      use.bundles.push(bundle.label);
      uses.set(section, use);
    }
  }
  return [...uses.entries()].sort(([a], [b]) => a.order - b.order).map(([, use]) => use);
}
