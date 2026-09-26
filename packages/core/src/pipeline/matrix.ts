import picomatch from "picomatch";
import type { Bundle } from "../bundle/bundle.js";
import type { RiskTier } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";

export const RISK_TIERS: readonly RiskTier[] = ["trivial", "lite", "full"];

export interface ReviewerOverride {
  enabled?: boolean | undefined;
  minTier?: RiskTier | undefined;
}

export type ReviewerOverrides = Readonly<Record<string, ReviewerOverride>>;

export interface MatrixCell {
  taskId: string;
  reviewer: ReviewerDefinition;
  // The bundle narrowed to the files this reviewer cares about.
  bundle: Bundle;
}

export type SkipReason = "disabled" | "below_tier" | "no_matching_files";

export interface SkippedCell {
  reviewer: string;
  bundle: string;
  reason: SkipReason;
}

export interface ReviewMatrix {
  cells: MatrixCell[];
  skipped: SkippedCell[];
}

// Deterministic: which reviewer runs on which bundle, so cost grows with the
// risk of the change instead of bundles × reviewers.
export function planMatrix(
  bundles: readonly Bundle[],
  reviewers: readonly ReviewerDefinition[],
  tier: RiskTier,
  overrides: ReviewerOverrides = {},
): ReviewMatrix {
  const cells: MatrixCell[] = [];
  const skipped: SkippedCell[] = [];
  const ignores = new Map(reviewers.map((r) => [r.id, ignoreMatcher(r)]));

  bundles.forEach((bundle, i) => {
    for (const reviewer of reviewers) {
      const override = overrides[reviewer.id] ?? {};
      const skip = (reason: SkipReason) =>
        skipped.push({ reviewer: reviewer.id, bundle: bundle.label, reason });

      if (override.enabled === false) {
        skip("disabled");
        continue;
      }
      const minTier = override.minTier ?? reviewer.scope?.minTier ?? "trivial";
      if (rank(tier) < rank(minTier)) {
        skip("below_tier");
        continue;
      }
      const ignored = ignores.get(reviewer.id) ?? (() => false);
      const files = bundle.files.filter((f) => !ignored(f.newPath));
      if (files.length === 0) {
        skip("no_matching_files");
        continue;
      }
      cells.push({
        taskId: `${reviewer.id}-${i + 1}`,
        reviewer,
        bundle: files.length === bundle.files.length ? bundle : { ...bundle, files },
      });
    }
  });
  return { cells, skipped };
}

function rank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

function ignoreMatcher(reviewer: ReviewerDefinition): (path: string) => boolean {
  const globs = reviewer.scope?.ignore ?? [];
  return globs.length === 0 ? () => false : picomatch([...globs], { dot: true, nocase: true });
}
