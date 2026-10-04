// CHANGELOG.md in the Keep a Changelog 1.1.0 format, and the changeset
// fragments that become its entries. Pure, so scripts/changelog.mjs and
// scripts/release.mjs share it and the tests need no git or npm.

export const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

const VERSION = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const RELEASE_HEADING = new RegExp(String.raw`^## \[(${VERSION})\] - (\d{4}-\d{2}-\d{2})$`);
const UNRELEASED_HEADING = "## [Unreleased]";
const LINK = /^\[([^\]]+)\]: (\S+)$/;

/**
 * @typedef {Record<string, string[]>} Entries
 * @typedef {{ heading: string, version: string | undefined, date: string | undefined, body: string }} Section
 */

// A changelog fragment: an optional paragraph, then "### <Category>"
// headings, each followed by "- " bullets (a bullet may go on over indented
// lines). A changeset's body is one, and so is a section of CHANGELOG.md.
/**
 * @param {string} text
 * @param {{ prose?: boolean }} [options]
 */
export function parseFragment(text, { prose: allowProse = true } = {}) {
  /** @type {Entries} */
  const entries = {};
  /** @type {string[]} */
  const prose = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {string | undefined} */
  let category;
  let inSection = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      if (!inSection && prose.length > 0) prose.push("");
      continue;
    }
    const heading = /^(#+) (.*)$/.exec(trimmed);
    if (heading) {
      inSection = true;
      const title = /** @type {string} */ (heading[2]);
      category = heading[1] === "###" && CATEGORIES.includes(title) ? title : undefined;
      if (!category) {
        problems.push(`"${trimmed}" is not a section; use ### ${CATEGORIES.join(", ### ")}`);
      } else entries[category] ??= [];
      continue;
    }
    const bullets = category && entries[category];
    if (line.startsWith("- ")) {
      if (bullets) bullets.push(line);
      else if (!inSection) problems.push(`"${trimmed}" comes before any ### section`);
    } else if (/^\s/.test(line) && bullets && bullets.length > 0) {
      bullets[bullets.length - 1] += `\n${line.trimEnd()}`;
    } else if (!inSection && allowProse) {
      prose.push(line.trimEnd());
    } else if (!inSection || category) {
      problems.push(`"${trimmed}" is not a "- " bullet under a ### section`);
    }
  }
  for (const [name, list] of Object.entries(entries)) {
    if (list.length === 0) problems.push(`### ${name} has no entries`);
  }
  return { prose: prose.join("\n").trim(), entries, problems };
}

/** @param {Entries} entries */
export function renderEntries(entries) {
  return CATEGORIES.filter((name) => (entries[name]?.length ?? 0) > 0)
    .map((name) => `### ${name}\n\n${entries[name]?.join("\n")}`)
    .join("\n\n");
}

/** @param {{ entries: Entries }[]} fragments */
function mergeEntries(fragments) {
  /** @type {Entries} */
  const merged = {};
  for (const { entries } of fragments) {
    for (const [name, list] of Object.entries(entries))
      merged[name] = [...(merged[name] ?? []), ...list];
  }
  return merged;
}

// The title and introduction, the "## " sections in order, and the link
// definitions at the end.
/**
 * @param {string} text
 * @returns {{ head: string, sections: Section[], links: string[] }}
 */
export function splitChangelog(text) {
  const lines = text.trimEnd().split("\n");
  let end = lines.length;
  for (; end > 0; end--) {
    const line = /** @type {string} */ (lines[end - 1]);
    if (!LINK.test(line) && line.trim() !== "") break;
  }
  const links = lines.slice(end).filter((line) => line.trim() !== "");
  /** @type {{ heading: string, body: string[] }[]} */
  const sections = [];
  /** @type {string[]} */
  const head = [];
  for (const line of lines.slice(0, end)) {
    if (line.startsWith("## ")) sections.push({ heading: line, body: [] });
    else if (sections.length > 0) sections[sections.length - 1]?.body.push(line);
    else head.push(line);
  }
  return {
    head: head.join("\n").trim(),
    sections: sections.map(({ heading, body }) => {
      const release = RELEASE_HEADING.exec(heading);
      return {
        heading,
        version: heading === UNRELEASED_HEADING ? "Unreleased" : release?.[1],
        date: release?.[2],
        body: body.join("\n").trim(),
      };
    }),
    links,
  };
}

/** @param {{ head: string, sections: { heading: string, body: string }[], links: string[] }} doc */
function joinChangelog({ head, sections, links }) {
  const parts = sections.map(({ heading, body }) => (body ? `${heading}\n\n${body}` : heading));
  return `${[head, ...parts, links.join("\n")].join("\n\n")}\n`;
}

// What is wrong with a CHANGELOG.md, as a list.
/** @param {string} text */
export function changelogProblems(text) {
  const { sections, links } = splitChangelog(text);
  /** @type {string[]} */
  const problems = [];
  const linked = new Set(links.map((line) => LINK.exec(line)?.[1]));
  if (sections[0]?.version !== "Unreleased") {
    problems.push(`the first section must be "${UNRELEASED_HEADING}"`);
  }
  for (const section of sections) {
    if (!section.version) {
      problems.push(
        `"${section.heading}" is not "## [x.y.z] - YYYY-MM-DD" or "${UNRELEASED_HEADING}"`,
      );
      continue;
    }
    if (!linked.has(section.version)) problems.push(`[${section.version}] has no link at the end`);
    for (const problem of parseFragment(section.body).problems) {
      problems.push(`[${section.version}]: ${problem}`);
    }
  }
  return problems;
}

// The body of the "## [<version>] - <date>" section, the GitHub release's
// notes, or undefined.
/**
 * @param {string} text
 * @param {string} version
 */
export function releaseNotes(text, version) {
  const section = splitChangelog(text).sections.find((s) => s.version === version && s.date);
  return section?.body || undefined;
}

// CHANGELOG.md with a section for the release: what [Unreleased] held, then
// the changesets' entries, by category. [Unreleased] is left empty and the
// compare links move on. Throws when there is nothing to release or the
// changelog is not one this can extend.
/**
 * @param {string} text
 * @param {{ version: string, date: string, fragments: { entries: Entries }[] }} release
 */
export function cutRelease(text, { version, date, fragments }) {
  const problems = changelogProblems(text);
  if (problems.length > 0) throw new Error(`CHANGELOG.md: ${problems.join("; ")}`);
  const doc = splitChangelog(text);
  if (doc.sections.some((s) => s.version === version)) {
    throw new Error(`CHANGELOG.md already has a section for ${version}`);
  }
  // changelogProblems found the [Unreleased] section first.
  const [unreleasedSection, ...released] = /** @type {[Section, ...Section[]]} */ (doc.sections);
  const unreleased = parseFragment(unreleasedSection.body);
  const entries = mergeEntries([unreleased, ...fragments]);
  const body = [unreleased.prose, renderEntries(entries)].filter(Boolean).join("\n\n");
  if (renderEntries(entries) === "") throw new Error(`nothing to release in ${version}`);
  const unreleasedLink = doc.links.find((line) => LINK.exec(line)?.[1] === "Unreleased");
  const repo = /^\[Unreleased\]: (\S+)\/compare\//.exec(unreleasedLink ?? "")?.[1];
  if (!repo) throw new Error("CHANGELOG.md has no [Unreleased]: <repo>/compare/... link");
  const previous = released[0]?.version;
  const links = [
    `[Unreleased]: ${repo}/compare/v${version}...HEAD`,
    previous
      ? `[${version}]: ${repo}/compare/v${previous}...v${version}`
      : `[${version}]: ${repo}/releases/tag/v${version}`,
    ...doc.links.filter((line) => line !== unreleasedLink),
  ];
  const sections = [
    { heading: UNRELEASED_HEADING, body: "" },
    { heading: `## [${version}] - ${date}`, body },
    ...released,
  ];
  return joinChangelog({ head: doc.head, sections, links });
}
