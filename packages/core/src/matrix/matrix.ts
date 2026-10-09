import picomatch from "picomatch";
import { z } from "zod";
import type { ReviewerOverrides } from "../agent/settings.js";
import type { Bundle } from "../bundle/bundle.js";
import { RISK_TIERS, type RiskTier } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";

export interface MatrixCell {
  taskId: string;
  reviewer: ReviewerDefinition;
  // The bundle narrowed to the files this reviewer cares about.
  bundle: Bundle;
}

export const skipReasonSchema = z.enum([
  "disabled",
  "below_tier",
  "no_matching_files",
  "no_guidelines",
  "task_limit",
]);
export type SkipReason = z.infer<typeof skipReasonSchema>;

export interface SkippedCell {
  reviewer: string;
  bundle: string;
  reason: SkipReason;
}

export interface ReviewMatrix {
  cells: MatrixCell[];
  skipped: SkippedCell[];
  // Cells the task limit cut, so coverage can report their files.
  limited?: MatrixCell[];
}

// Deterministic: which reviewer runs on which bundle, so cost grows with the
// risk of the change instead of bundles × reviewers.
export function planMatrix(
  bundles: readonly Bundle[],
  reviewers: readonly ReviewerDefinition[],
  tier: RiskTier,
  overrides: ReviewerOverrides = {},
  options: { allTiers?: boolean; hasGuidelines?: boolean } = {},
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
      const minTier = options.allTiers
        ? "trivial"
        : (override.minTier ?? reviewer.scope?.minTier ?? "trivial");
      if (rank(tier) < rank(minTier)) {
        skip("below_tier");
        continue;
      }
      if (reviewer.scope?.requiresGuidelines && options.hasGuidelines !== true) {
        skip("no_guidelines");
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

// Every review task is a model conversation, so a change set with hundreds
// of bundles must not become hundreds of tasks.
export const DEFAULT_MAX_TASKS = 60;

export interface TaskOptions {
  ultra?: boolean;
  maxTasks?: number;
  hasGuidelines?: boolean;
}

// The matrix as it runs: --ultra reviews every cell twice, and past
// `maxTasks` the least important cells are skipped: second samples first,
// then reviewers in reverse registration order (correctness first), so
// every file keeps its first reviewer as long as possible.
export function planTasks(
  bundles: readonly Bundle[],
  reviewers: readonly ReviewerDefinition[],
  tier: RiskTier,
  overrides: ReviewerOverrides = {},
  options: TaskOptions = {},
): ReviewMatrix {
  const planned = planMatrix(bundles, reviewers, tier, overrides, {
    allTiers: options.ultra === true,
    hasGuidelines: options.hasGuidelines === true,
  });
  const cells = options.ultra
    ? planned.cells.flatMap((cell) => [cell, { ...cell, taskId: `${cell.taskId}b` }])
    : planned.cells;
  const max = options.maxTasks ?? DEFAULT_MAX_TASKS;
  if (cells.length <= max) return { cells, skipped: planned.skipped };

  const order = new Map(reviewers.map((r, i) => [r.id, i]));
  const priority = (cell: MatrixCell, index: number): [number, number, number] => [
    cell.taskId.endsWith("b") ? 1 : 0,
    order.get(cell.reviewer.id) ?? reviewers.length,
    index,
  ];
  const ranked = cells
    .map((cell, index) => ({ cell, key: priority(cell, index) }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2]);
  const kept = new Set(ranked.slice(0, max).map((r) => r.cell));
  return {
    cells: cells.filter((cell) => kept.has(cell)),
    limited: cells.filter((cell) => !kept.has(cell)),
    skipped: [
      ...planned.skipped,
      ...cells
        .filter((cell) => !kept.has(cell))
        .map((cell) => ({
          reviewer: cell.reviewer.id,
          bundle: cell.bundle.label,
          reason: "task_limit" as const,
        })),
    ],
  };
}

export function rank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

function ignoreMatcher(reviewer: ReviewerDefinition): (path: string) => boolean {
  const globs = reviewer.scope?.ignore ?? [];
  return globs.length === 0 ? () => false : picomatch([...globs], { dot: true, nocase: true });
}
