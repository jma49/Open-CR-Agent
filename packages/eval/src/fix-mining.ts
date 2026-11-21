import { MAX_REQUIRED_CLAIMS, parseCandidate } from "./golden.js";

// Golden case candidates from a repository's own history, labelled by what
// happened after a change merged rather than by anyone's judgement: a later
// fix or revert that rewrote lines a commit introduced says those lines held
// a defect a review of that commit should have reported (SZZ). Nobody labels
// them by hand; the noise SZZ is known for is cut by the filters here, and
// every candidate says it is unverified.

// A fix touching more source files than this is usually a refactor that
// happens to say "fix"; its blamed lines say little about one defect.
export const MAX_FIX_FILES = 5;
// Same bound as a required golden claim (golden.ts).
const MAX_CLAIM_SPAN = 15;

// Conventional Commits' fix and revert, plus the plain wording of
// repositories that do not use them.
const FIX_SUBJECT = /^(fix|revert)(\([^)]*\))?!?:|^revert\b|\b(fix(es|ed)?|bug)\b/i;

export function isFixSubject(subject: string): boolean {
  return FIX_SUBJECT.test(subject);
}

// Source files only: a defect in docs, tests, snapshots, lockfiles or
// generated data is not what the reviewers are asked to find.
const NOT_SOURCE =
  /\.(md|mdx|rst|txt|json|jsonc|lock|snap|ya?ml|toml|svg|png|jpe?g|gif|csv)$|(^|\/)(CHANGELOG|LICENSE)[^/]*$|\.(test|spec|e2e)\.|(^|\/)(__snapshots__|__tests__|tests?|fixtures?|\.changeset)\//i;

export function isMinedPath(path: string): boolean {
  return !NOT_SOURCE.test(path);
}

export interface OldRange {
  start: number;
  count: number;
}

// The pre-image ranges a `git diff -U0` hunk rewrote or removed; pure
// additions rewrite nothing, so nothing is blamed for them.
export function rewrittenRanges(diff: string): OldRange[] {
  const ranges: OldRange[] = [];
  for (const match of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/gm)) {
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push({ start: Number(match[1]), count });
  }
  return ranges;
}

export interface BlamedLine {
  commit: string;
  // The file and line number in the commit that introduced it: blame
  // follows renames, so the file can differ from the one blamed.
  file: string;
  line: number;
  text: string;
}

// `git blame --porcelain` output: a header per line ("<sha> <orig> <final>
// [<count>]"), header fields, then the line itself after a tab. A commit's
// `filename` field comes only with its first header.
export function parseBlame(porcelain: string, blamedFile: string): BlamedLine[] {
  const lines: BlamedLine[] = [];
  const fileOf = new Map<string, string>();
  let current: { commit: string; line: number } | undefined;
  for (const row of porcelain.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) \d+/.exec(row);
    if (header?.[1] && header[2]) {
      current = { commit: header[1], line: Number(header[2]) };
    } else if (row.startsWith("filename ") && current) {
      fileOf.set(current.commit, row.slice("filename ".length));
    } else if (row.startsWith("\t") && current) {
      const file = fileOf.get(current.commit) ?? blamedFile;
      lines.push({ ...current, file, text: row.slice(1) });
      current = undefined;
    }
  }
  return lines;
}

// Lines that carry no behaviour: blank lines, lone brackets, comments.
export function isTrivialLine(text: string): boolean {
  const t = text.trim();
  return t === "" || /^[{}()[\];,]+$/.test(t) || /^(\/\/|#|\*|\/\*|\*\/|<!--)/.test(t);
}

export interface FixCommit {
  sha: string;
  subject: string;
}

export interface MinedClaim {
  // The commit whose review should have reported it.
  introduced: string;
  fix: FixCommit;
  file: string;
  lines: [number, number];
}

// Runs of consecutive introduced lines in one file become one claim each;
// a run longer than a required claim may span is left out.
export function claimsFrom(fix: FixCommit, blamed: readonly BlamedLine[]): MinedClaim[] {
  const byPlace = new Map<string, { introduced: string; file: string; numbers: number[] }>();
  for (const b of blamed) {
    if (b.commit === fix.sha || isTrivialLine(b.text) || !isMinedPath(b.file)) continue;
    const key = `${b.commit}\0${b.file}`;
    const place = byPlace.get(key) ?? { introduced: b.commit, file: b.file, numbers: [] };
    place.numbers.push(b.line);
    byPlace.set(key, place);
  }
  const claims: MinedClaim[] = [];
  for (const { introduced, file, numbers } of byPlace.values()) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    let start = sorted[0];
    for (let i = 0; i < sorted.length; i++) {
      const line = sorted[i] as number;
      const next = sorted[i + 1];
      if (next === line + 1) continue;
      const from = start as number;
      if (line - from + 1 <= MAX_CLAIM_SPAN) {
        claims.push({ introduced, fix, file, lines: [from, line] });
      }
      start = next;
    }
  }
  return claims;
}

export interface IntroducingCommit {
  sha: string;
  parent: string;
  subject: string;
  // Committer date, YYYY-MM-DD.
  date: string;
  changedLines: number;
}

const SECURITY_WORDS = /\b(security|vulnerab\w*|cve|xss|csrf|injection|traversal|secret|leak)\b/i;

const EXTENSION_LANGUAGE: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  js: "javascript",
  mjs: "javascript",
  jsx: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  cs: "csharp",
  cpp: "cpp",
  cc: "cpp",
  c: "c",
  h: "c",
  rb: "ruby",
  php: "php",
  swift: "swift",
};

function languageOf(files: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = EXTENSION_LANGUAGE[file.split(".").pop()?.toLowerCase() ?? ""] ?? "other";
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}

export interface CaseOptions {
  repo: string;
  licence: string;
}

// One candidate per introducing commit, one claim per fix: a fix's places
// are one defect, so its smallest range is the claim and the rest are where
// the same defect is also rightly reported. Fixes with the most specific
// evidence come first, up to the required cap. The severity floor is the
// lowest: no one decided how bad each defect was.
export function candidateCase(
  commit: IntroducingCommit,
  claims: readonly MinedClaim[],
  options: CaseOptions,
): unknown {
  const span = (c: MinedClaim) => c.lines[1] - c.lines[0];
  const byFix = new Map<string, MinedClaim[]>();
  for (const claim of claims)
    byFix.set(claim.fix.sha, [...(byFix.get(claim.fix.sha) ?? []), claim]);
  const groups = [...byFix.values()]
    .map((group) =>
      [...group].sort(
        (a, b) => span(a) - span(b) || a.file.localeCompare(b.file) || a.lines[0] - b.lines[0],
      ),
    )
    .sort(
      (a, b) =>
        a.length - b.length ||
        span(a[0] as MinedClaim) - span(b[0] as MinedClaim) ||
        (a[0] as MinedClaim).fix.sha.localeCompare((b[0] as MinedClaim).fix.sha),
    )
    .slice(0, MAX_REQUIRED_CLAIMS);
  const ordered = groups.map((g) => g[0] as MinedClaim);
  const name =
    options.repo
      .split("/")[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-") ?? "repo";
  const fixes = [...new Set(ordered.map((c) => `${c.fix.sha.slice(0, 12)} (${c.fix.subject})`))];
  const candidate = {
    id: `fix-${name}-${commit.sha.slice(0, 12)}`,
    repo: options.repo,
    base: commit.parent,
    head: commit.sha,
    language: languageOf(ordered.map((c) => c.file)),
    tier: "full",
    source: {
      kind: "github",
      ref: `${options.repo}@${commit.sha}`,
      licence: options.licence,
      date: commit.date,
    },
    rationale: `Unverified: mined from later fixes, not checked by anyone. "${commit.subject}" introduced lines that ${fixes.join(", ")} rewrote.`,
    expect: ordered.map((c, i) => ({
      id: `fix-${i + 1}`,
      file: c.file,
      lines: c.lines,
      category: SECURITY_WORDS.test(c.fix.subject) ? "security" : "correctness",
      minSeverity: "suggestion",
      concern: `Later fixed by ${c.fix.sha.slice(0, 12)}: ${c.fix.subject}`,
      also: (groups[i] ?? []).slice(1).map((o) => ({ file: o.file, lines: o.lines })),
      origin: "author-fix",
      producer: "szz",
    })),
  };
  // Validated as a candidate: a schema change surfaces here, not at load.
  parseCandidate(candidate, candidate.id);
  return candidate;
}
