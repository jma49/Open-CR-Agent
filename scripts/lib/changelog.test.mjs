import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  changelogProblems,
  cutRelease,
  latestRelease,
  parseFragment,
  releaseNotes,
  renderEntries,
} from "./changelog.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const repo = "https://github.com/o/r";

const changelog = `# Changelog

Intro.

## [Unreleased]

Summary of the release.

### Fixed

- an unreleased fix

## [0.2.0] - 2026-09-29

### Added

- two
  continued

## [0.1.0] - 2026-09-28

First.

### Added

- one

[Unreleased]: ${repo}/compare/v0.2.0...HEAD
[0.2.0]: ${repo}/compare/v0.1.0...v0.2.0
[0.1.0]: ${repo}/releases/tag/v0.1.0
`;

describe("parseFragment", () => {
  it("reads entries by category, with continued bullets and an opening paragraph", () => {
    const fragment = parseFragment("Intro.\n\n### Fixed\n\n- a\n  more\n- b\n\n### Added\n\n- c\n");
    expect(fragment).toEqual({
      prose: "Intro.",
      entries: { Fixed: ["- a\n  more", "- b"], Added: ["- c"] },
      problems: [],
    });
    expect(renderEntries(fragment.entries)).toBe(
      "### Added\n\n- c\n\n### Fixed\n\n- a\n  more\n- b",
    );
  });

  it("names unknown sections, stray text, empty sections, and prose where none is allowed", () => {
    expect(parseFragment("### New\n\n- a\n").problems).toEqual([
      '"### New" is not a section; use ### Added, ### Changed, ### Deprecated, ### Removed, ### Fixed, ### Security',
    ]);
    expect(parseFragment("- a\n").problems).toEqual(['"- a" comes before any ### section']);
    expect(parseFragment("### Fixed\n\ntext\n").problems).toEqual([
      '"text" is not a "- " bullet under a ### section',
      "### Fixed has no entries",
    ]);
    expect(parseFragment("Intro.\n### Fixed\n- a", { prose: false }).problems).toEqual([
      '"Intro." is not a "- " bullet under a ### section',
    ]);
    expect(parseFragment("").problems).toEqual([]);
  });
});

describe("changelogProblems", () => {
  it("accepts Keep a Changelog sections with a link each", () => {
    expect(changelogProblems(changelog)).toEqual([]);
  });

  it("names a section without a date or a link, and an Unreleased section that is not first", () => {
    const broken = "# C\n\n## 0.2.0\n\n### Added\n\n- x\n\n## [0.1.0] - 2026-09-28\n\n- y\n";
    expect(changelogProblems(broken)).toEqual([
      'the first section must be "## [Unreleased]"',
      '"## 0.2.0" is not "## [x.y.z] - YYYY-MM-DD" or "## [Unreleased]"',
      "[0.1.0] has no link at the end",
      '[0.1.0]: "- y" comes before any ### section',
    ]);
  });

  it("finds nothing wrong with this repository's CHANGELOG.md", () => {
    expect(changelogProblems(readFileSync(join(root, "CHANGELOG.md"), "utf8"))).toEqual([]);
  });
});

describe("releaseNotes", () => {
  it("returns one release's section without its heading", () => {
    expect(releaseNotes(changelog, "0.2.0")).toBe("### Added\n\n- two\n  continued");
    expect(releaseNotes(changelog, "0.1.0")).toBe("First.\n\n### Added\n\n- one");
  });

  it("finds nothing for Unreleased, another version or a prefix of one", () => {
    for (const version of ["Unreleased", "0.3.0", "0.1"]) {
      expect(releaseNotes(changelog, version)).toBeUndefined();
    }
  });
});

describe("latestRelease", () => {
  it("is the newest dated section, never Unreleased", () => {
    expect(latestRelease(changelog)).toEqual({ version: "0.2.0", date: "2026-09-29" });
    expect(latestRelease("# C\n\n## [Unreleased]\n\n### Fixed\n\n- a\n")).toBeUndefined();
  });
});

describe("cutRelease", () => {
  /** @param {string} text */
  const fragment = (text) => parseFragment(text, { prose: false });

  it("moves Unreleased and the changesets into the release, and the links on", () => {
    const next = cutRelease(changelog, {
      version: "0.3.0",
      date: "2026-10-03",
      fragments: [fragment("### Fixed\n\n- a changeset fix"), fragment("### Added\n\n- new")],
    });
    expect(next).toBe(`# Changelog

Intro.

## [Unreleased]

## [0.3.0] - 2026-10-03

Summary of the release.

### Added

- new

### Fixed

- an unreleased fix
- a changeset fix

## [0.2.0] - 2026-09-29

### Added

- two
  continued

## [0.1.0] - 2026-09-28

First.

### Added

- one

[Unreleased]: ${repo}/compare/v0.3.0...HEAD
[0.3.0]: ${repo}/compare/v0.2.0...v0.3.0
[0.2.0]: ${repo}/compare/v0.1.0...v0.2.0
[0.1.0]: ${repo}/releases/tag/v0.1.0
`);
    expect(changelogProblems(next)).toEqual([]);
    expect(releaseNotes(next, "0.3.0")).toContain("- a changeset fix");
  });

  it("refuses a version it has, an empty release, and a changelog it cannot read", () => {
    const options = { date: "2026-10-03", fragments: [] };
    expect(() => cutRelease(changelog, { ...options, version: "0.2.0" })).toThrow(
      "already has a section for 0.2.0",
    );
    const empty = changelog.replace("### Fixed\n\n- an unreleased fix\n", "");
    expect(() => cutRelease(empty, { ...options, version: "0.3.0" })).toThrow("nothing to release");
    expect(() => cutRelease("# C\n\n## 1.0\n", { ...options, version: "0.3.0" })).toThrow(
      "CHANGELOG.md:",
    );
  });
});

describe("the pending changesets", () => {
  it("are changelog entries under Keep a Changelog sections", () => {
    const dir = join(root, ".changeset");
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md")
      : [];
    for (const file of files) {
      const body = readFileSync(join(dir, file), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "");
      expect(parseFragment(body, { prose: false }).problems, file).toEqual([]);
    }
  });
});
