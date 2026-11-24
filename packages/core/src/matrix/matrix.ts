import picomatch from "picomatch";
import { z } from "zod";
import type { ReviewerOverrides } from "../agent/settings.js";
import { type Bundle, type BundlePolicy, defaultBundlePolicy } from "../bundle/bundle.js";
import { type FileDiff, RISK_TIERS, type RiskTier } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { hasPathWord, touchesSensitivePath } from "../triage.js";

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

const WHOLE_CHANGE_LABEL = "whole change";
const PACKED_LABEL_SEPARATOR = " + ";
const WHOLE_CHANGE_MAX_FILES = 20;

export interface ReviewMatrix {
  cells: MatrixCell[];
  skipped: SkippedCell[];
  // Cells the task limit cut, so coverage can report their files.
  limited?: MatrixCell[];
}

// Deterministic: which reviewer runs on which bundle, so cost grows with the
// risk of the change instead of bundles × reviewers. Cells come in run order:
// bundles on sensitive paths first, so a spend limit that ends the run early
// has spent itself on them (ADR-0049); task ids keep the bundle's position.
// A packed reviewer's task comes once its pack is full; a reviewer
// that spans the change comes last, its files in the same order.
export function planMatrix(
  bundles: readonly Bundle[],
  reviewers: readonly ReviewerDefinition[],
  tier: RiskTier,
  overrides: ReviewerOverrides = {},
  options: { allTiers?: boolean; hasGuidelines?: boolean; bundling?: BundlePolicy } = {},
): ReviewMatrix {
  const policy = options.bundling ?? defaultBundlePolicy;
  const cells: MatrixCell[] = [];
  const skipped: SkippedCell[] = [];
  const ignores = new Map(reviewers.map((r) => [r.id, ignoreMatcher(r)]));

  const whole = new Map<ReviewerDefinition, { files: FileDiff[]; from: Set<Bundle> }>();
  const packs = new Map<ReviewerDefinition, Pack>();
  const closePack = (reviewer: ReviewerDefinition) => {
    const pack = packs.get(reviewer);
    if (pack) cells.push(packedCell(reviewer, pack));
    packs.delete(reviewer);
  };

  for (const { bundle, i, sensitive } of riskOrder(bundles)) {
    for (const reviewer of reviewers) {
      const override = overrides[reviewer.id] ?? {};
      const skip = (reason: SkipReason) =>
        skipped.push({ reviewer: reviewer.id, bundle: bundle.label, reason });

      if (override.enabled === false) {
        skip("disabled");
        continue;
      }
      const ignored = ignores.get(reviewer.id) ?? (() => false);
      const files = bundle.files.filter((f) => !ignored(f.newPath));
      const minTier = options.allTiers
        ? "trivial"
        : (override.minTier ?? scopeTier(reviewer, files));
      if (rank(tier) < rank(minTier)) {
        skip("below_tier");
        continue;
      }
      if (reviewer.scope?.requiresGuidelines && options.hasGuidelines !== true) {
        skip("no_guidelines");
        continue;
      }
      if (files.length === 0) {
        skip("no_matching_files");
        continue;
      }
      if (reviewer.scope?.span === "change") {
        const gathered = whole.get(reviewer) ?? { files: [], from: new Set<Bundle>() };
        gathered.files.push(...files);
        gathered.from.add(bundle);
        whole.set(reviewer, gathered);
        continue;
      }
      const narrowed = files.length === bundle.files.length ? bundle : { ...bundle, files };
      if (reviewer.scope?.span === "packed") {
        const pack = packs.get(reviewer);
        if (pack && fitsPack(pack, narrowed, sensitive, policy)) {
          pack.bundles.push(narrowed);
          continue;
        }
        closePack(reviewer);
        packs.set(reviewer, { first: i, sensitive, bundles: [narrowed] });
        continue;
      }
      cells.push({ taskId: `${reviewer.id}-${i + 1}`, reviewer, bundle: narrowed });
    }
  }
  for (const reviewer of [...packs.keys()]) closePack(reviewer);
  for (const [reviewer, { files, from }] of whole) {
    const [only] = from;
    const parts = from.size === 1 && only ? [{ ...only, files }] : wholeChange(files, policy);
    cells.push(
      ...parts.map((bundle, n) => ({ taskId: `${reviewer.id}-${n + 1}`, reviewer, bundle })),
    );
  }
  return { cells, skipped };
}

interface Pack {
  // The run position of its first bundle, which names the task.
  first: number;
  sensitive: boolean;
  bundles: Bundle[];
}

// A pack keeps bundles whole and within the bundle limits, and never mixes
// sensitive bundles with the rest, so they still run first (ADR-0049).
function fitsPack(pack: Pack, bundle: Bundle, sensitive: boolean, policy: BundlePolicy): boolean {
  const files = pack.bundles.flatMap((b) => b.files);
  const chars = (list: readonly FileDiff[]) => list.reduce((sum, f) => sum + f.patch.length, 0);
  return (
    pack.sensitive === sensitive &&
    files.length + bundle.files.length <= policy.maxFilesPerBundle &&
    chars(files) + chars(bundle.files) <= policy.maxBundleChars
  );
}

function packedCell(reviewer: ReviewerDefinition, pack: Pack): MatrixCell {
  const [only] = pack.bundles;
  const bundle =
    pack.bundles.length === 1 && only
      ? only
      : {
          label: pack.bundles.map((b) => b.label).join(PACKED_LABEL_SEPARATOR),
          files: pack.bundles.flatMap((b) => b.files),
        };
  return { taskId: `${reviewer.id}-${pack.first + 1}`, reviewer, bundle };
}

// The change as one bundle, or as few as keep a task within what one
// conversation reviews well.
function wholeChange(files: readonly FileDiff[], policy: BundlePolicy): Bundle[] {
  const parts: FileDiff[][] = [];
  let chars = 0;
  for (const file of files) {
    const part = parts.at(-1);
    const fits =
      part !== undefined &&
      part.length < WHOLE_CHANGE_MAX_FILES &&
      chars + file.patch.length <= policy.maxBundleChars;
    if (fits) part.push(file);
    else parts.push([file]);
    chars = fits ? chars + file.patch.length : file.patch.length;
  }
  return parts.map((part, n) => ({
    label:
      parts.length === 1
        ? WHOLE_CHANGE_LABEL
        : `${WHOLE_CHANGE_LABEL} (${n + 1} of ${parts.length})`,
    files: part,
  }));
}

function riskOrder(
  bundles: readonly Bundle[],
): { bundle: Bundle; i: number; sensitive: boolean }[] {
  const indexed = bundles.map((bundle, i) => ({
    bundle,
    i,
    sensitive: touchesSensitivePath(bundle.files),
  }));
  return [...indexed.filter((b) => b.sensitive), ...indexed.filter((b) => !b.sensitive)];
}

// Every review task is a model conversation, so a change set with hundreds
// of bundles must not become hundreds of tasks.
export const DEFAULT_MAX_TASKS = 60;

export interface TaskOptions {
  ultra?: boolean;
  maxTasks?: number;
  hasGuidelines?: boolean;
  bundling?: BundlePolicy;
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
    ...(options.bundling ? { bundling: options.bundling } : {}),
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

// The reviewer's own lowest tier for these files: its focus tier when one
// of them is on a focus path (ADR-0082).
function scopeTier(reviewer: ReviewerDefinition, files: readonly FileDiff[]): RiskTier {
  const { minTier = "trivial", focus } = reviewer.scope ?? {};
  const focused =
    focus !== undefined &&
    files.some((f) => hasPathWord(f.newPath, focus.words) || hasPathWord(f.oldPath, focus.words));
  return focused ? focus.minTier : minTier;
}

function ignoreMatcher(reviewer: ReviewerDefinition): (path: string) => boolean {
  const globs = reviewer.scope?.ignore ?? [];
  return globs.length === 0 ? () => false : picomatch([...globs], { dot: true, nocase: true });
}
