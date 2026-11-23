import picomatch from "picomatch";
import type { SyntaxChecker } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import { isTestFile } from "../generate/languages.js";
import { headMode } from "../generate/targets.js";
import { GENERATED_PATTERNS, MIGRATION_PATTERNS } from "../select/patterns.js";
import { defaultSelectionPolicy, selectFiles } from "../select/select.js";
import { isUnsafeCodePoint } from "../unsafe-text.js";
import {
  addedLines,
  applyHunks,
  type CompositionLimits,
  type ItemPatch,
  replacedLines,
} from "./patch.js";

// What a commit of the loop never changes, whatever asks for it: how the
// change is built, tested and owned, and what ocra itself reads as trusted.
// A fix that needs one of these goes to a person.
const PROTECTED_PATTERNS = [
  ".github/**",
  ".gitlab/**",
  "**/.gitlab-ci.yml",
  ".circleci/**",
  ".buildkite/**",
  "**/Jenkinsfile",
  "**/azure-pipelines.yml",
  "**/bitbucket-pipelines.yml",
  ".ocra/**",
  "**/AGENTS.md",
  "**/CODEOWNERS",
  "**/package.json",
  "**/pyproject.toml",
  "**/requirements*.txt",
  "**/Pipfile",
  "**/go.mod",
  "**/Cargo.toml",
  "**/pom.xml",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/settings.gradle",
  "**/settings.gradle.kts",
  "**/Gemfile",
  "**/composer.json",
  "**/Dockerfile",
  "**/Makefile",
  ...GENERATED_PATTERNS,
  ...MIGRATION_PATTERNS,
];

// A call that turns a test off, per line of a test file.
const SKIP_MARKERS = [
  /\b(?:it|test|describe|context)\.(?:skip|only|todo)\b/,
  /\bx(?:it|describe|test)\s*\(/,
  /@(?:Ignore|Disabled)\b/,
  /@(?:pytest\.mark\.(?:skip|skipif|xfail)|unittest\.skip)/,
  /\bt\.Skip(?:f|Now)?\(/,
  /#\[ignore\b/,
];

export const GATE_REJECTIONS = [
  "out_of_scope",
  "protected",
  "tamper",
  "too_large",
  "unsafe",
  "stale",
  "no_parser",
  "syntax",
] as const;
type GateRejection = (typeof GATE_REJECTIONS)[number];

export interface MendScope {
  // Why a round may not edit the file; undefined when it may.
  refusal(path: string): "out_of_scope" | "protected" | undefined;
}

const globOptions = { dot: true, nocase: true };

// The files a round may edit: regular files of the change that a review
// would read, less the protected ones. `protectedPaths` adds patterns and
// removes none.
export function mendScope(
  diffs: readonly FileDiff[],
  protectedPaths: readonly string[] = [],
): MendScope {
  const isProtected = picomatch([...PROTECTED_PATTERNS, ...protectedPaths], globOptions);
  const editable = new Set(
    selectFiles(diffs, defaultSelectionPolicy)
      .filter((d) => d.selected && d.diff.kind !== "deleted" && isRegular(d.diff))
      .map((d) => d.diff.newPath),
  );
  return {
    refusal(path) {
      if (isProtected(path)) return "protected";
      return editable.has(path) ? undefined : "out_of_scope";
    },
  };
}

function isRegular(diff: FileDiff): boolean {
  const mode = headMode(diff) ?? "100644";
  return mode === "100644" || mode === "100755";
}

// The first rule one item's patch breaks. A patch is committed as written or
// not at all: the gate never repairs one.
export async function gate(
  patch: ItemPatch,
  heads: ReadonlyMap<string, string>,
  scope: MendScope,
  syntax: SyntaxChecker,
  limits: CompositionLimits,
): Promise<GateRejection | undefined> {
  const paths = [...new Set(patch.hunks.map((h) => h.path))];
  for (const path of paths) {
    const refused = scope.refusal(path);
    if (refused) return refused;
  }
  if (paths.length > limits.files || addedLines(patch) > limits.addedLines) return "too_large";
  for (const hunk of patch.hunks) {
    const before = heads.get(hunk.path);
    if (before === undefined || hunk.endLine > before.split("\n").length) return "stale";
    if (!committable(hunk.replacement)) return "unsafe";
    if (isTestFile(hunk.path) && skips(hunk.replacement) > skips(lines(before, hunk))) {
      return "tamper";
    }
  }
  for (const path of paths) {
    const before = heads.get(path) as string;
    const hunks = patch.hunks.filter((h) => h.path === path);
    const [was, now] = await Promise.all([
      syntax.errors(path, before),
      syntax.errors(path, applyHunks(before, hunks)),
    ]);
    if (was === undefined || now === undefined) return "no_parser";
    if (now > was) return "syntax";
  }
  return undefined;
}

function lines(content: string, hunk: ItemPatch["hunks"][number]): string {
  return replacedLines(content, hunk).join("\n");
}

function skips(text: string): number {
  return text.split("\n").filter((line) => SKIP_MARKERS.some((m) => m.test(line))).length;
}

function committable(text: string): boolean {
  for (const char of text) {
    if (isUnsafeCodePoint(char.codePointAt(0) as number)) return false;
  }
  return true;
}
