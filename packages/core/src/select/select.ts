import picomatch from "picomatch";
import { z } from "zod";
import type { FileDiff } from "../domain.js";
import {
  ENV_TEMPLATE_PATTERNS,
  GENERATED_PATTERNS,
  MIGRATION_PATTERNS,
  NON_REVIEWABLE_EXTENSIONS,
  SECRET_PATTERNS,
} from "./patterns.js";

export const exclusionReasonSchema = z.enum([
  "binary",
  "secret",
  "deleted",
  "user_exclude",
  "extension",
  "generated",
  "too_large",
]);
export type ExclusionReason = z.infer<typeof exclusionReasonSchema>;

export type FileDecision =
  | { diff: FileDiff; selected: true }
  | { diff: FileDiff; selected: false; reason: ExclusionReason };

export interface SelectionPolicy {
  include: readonly string[];
  exclude: readonly string[];
  maxPatchChars: number;
}

export const defaultSelectionPolicy: SelectionPolicy = {
  include: [],
  exclude: [],
  maxPatchChars: 200_000,
};

const globOptions = { dot: true, nocase: true };
const isSecret = picomatch(SECRET_PATTERNS, { ...globOptions, ignore: ENV_TEMPLATE_PATTERNS });
const isGenerated = picomatch(GENERATED_PATTERNS, globOptions);
const isMigration = picomatch(MIGRATION_PATTERNS, globOptions);
const nonReviewableExtensions = new Set(NON_REVIEWABLE_EXTENSIONS);

// The raw path is matched too: NFKC can fold a character into "/", which a
// pattern's "*" matches only in the raw path.
export function isSecretPath(path: string): boolean {
  return isSecret(path) || isSecret(foldPath(path));
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// A case-insensitive file system opens a file under any name that folds to
// the same as its own. APFS normalizes and applies full Unicode case folding,
// so a Kelvin sign opens "k", a long s "s", "ß" "ss" and a ligature its
// letters; HFS+ also skips some invisible characters. The access policy
// compares this form, which folds the ASCII names it refuses at least as far,
// so that no spelling of such a name passes. NFKC takes the Kelvin sign, the
// long s and ligatures to ASCII; upper-casing expands "ß" (and "ẞ", once
// lower-cased), which lower-casing keeps.
export function foldPath(path: string): string {
  return path.normalize("NFKC").replace(IGNORABLE, "").toLowerCase().toUpperCase().toLowerCase();
}

export function selectFiles(
  diffs: readonly FileDiff[],
  policy: SelectionPolicy = defaultSelectionPolicy,
): FileDecision[] {
  const isUserExcluded = matcher(policy.exclude);
  const isUserIncluded = matcher(policy.include);

  return diffs.map((diff) => {
    const reason = exclusionReason(diff, policy, isUserExcluded, isUserIncluded);
    return reason ? { diff, selected: false, reason } : { diff, selected: true };
  });
}

function exclusionReason(
  diff: FileDiff,
  policy: SelectionPolicy,
  isUserExcluded: (path: string) => boolean,
  isUserIncluded: (path: string) => boolean,
): ExclusionReason | undefined {
  const path = diff.newPath;
  if (diff.isBinary) return "binary";
  if (isSecretPath(diff.oldPath) || isSecretPath(path)) return "secret";
  if (diff.kind === "deleted") return "deleted";
  if (isUserExcluded(path)) return "user_exclude";

  if (!isUserIncluded(path)) {
    if (nonReviewableExtensions.has(extension(path))) return "extension";
    if (isGenerated(path) && !isMigration(path)) return "generated";
  }

  if (diff.patch.length > policy.maxPatchChars) return "too_large";
  return undefined;
}

function matcher(patterns: readonly string[]): (path: string) => boolean {
  return patterns.length === 0 ? () => false : picomatch([...patterns], globOptions);
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}
