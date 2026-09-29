import { type FileDiff, type ReviewPreview, RISK_TIERS, type RiskTier } from "@open-cr-agent/core";
import type { Dataset, Instance, ReferenceComment } from "./dataset.js";

// Why an annotated issue can or cannot be found, decided by the deterministic
// stages alone. It bounds recall before any model is involved.
export type Reachability =
  | "file_excluded"
  | "not_in_change"
  | "no_reviewer"
  | "out_of_scope"
  | "no_domain_reviewer"
  | "outside_diff"
  | "reachable";

export const REACHABILITY_ORDER: readonly Reachability[] = [
  "file_excluded",
  "not_in_change",
  "no_reviewer",
  "out_of_scope",
  "no_domain_reviewer",
  "outside_diff",
  "reachable",
];

// Findings ocra deliberately does not report, whatever the model sees.
const OUT_OF_SCOPE = new Set(["Maintainability and Readability"]);
// Categories that only a specialist reviewer is asked to look for.
const DOMAIN_REVIEWER: Record<string, string> = {
  "Security Vulnerability": "security",
  Performance: "performance",
};

export interface ReferenceReach {
  instance: string;
  path: string;
  category: string;
  reach: Reachability;
  detail?: string;
}

export function classifyReferences(
  instance: Instance,
  preview: ReviewPreview,
  diffs: readonly FileDiff[],
): ReferenceReach[] {
  const excluded = new Map(preview.excluded.map((e) => [e.path, e.reason]));
  const selected = new Set(preview.selected);
  const reviewersByFile = new Map<string, Set<string>>();
  for (const task of preview.tasks) {
    for (const file of task.files) {
      const set = reviewersByFile.get(file) ?? new Set<string>();
      set.add(task.reviewer);
      reviewersByFile.set(file, set);
    }
  }

  return instance.references.map((ref): ReferenceReach => {
    const base = { instance: instance.id, path: ref.path, category: ref.category };
    const reason = excluded.get(ref.path);
    if (reason) return { ...base, reach: "file_excluded", detail: reason };
    if (!selected.has(ref.path)) return { ...base, reach: "not_in_change" };
    const reviewers = reviewersByFile.get(ref.path);
    if (!reviewers || reviewers.size === 0) return { ...base, reach: "no_reviewer" };
    if (OUT_OF_SCOPE.has(ref.category)) return { ...base, reach: "out_of_scope" };
    const domain = DOMAIN_REVIEWER[ref.category];
    if (domain && !reviewers.has(domain)) {
      return { ...base, reach: "no_domain_reviewer", detail: domain };
    }
    if (
      !withinHunks(
        ref,
        diffs.find((d) => d.newPath === ref.path),
      )
    ) {
      return { ...base, reach: "outside_diff" };
    }
    return { ...base, reach: "reachable" };
  });
}

// Left-side comments are about removed lines, which reviewers see in the diff.
// A range counts when it overlaps a hunk, as matching does: a golden range
// can span a changed comment and the changed code it describes.
function withinHunks(ref: ReferenceComment, diff: FileDiff | undefined): boolean {
  if (!diff || ref.fromLine === null) return false;
  const from = ref.fromLine;
  const to = ref.toLine ?? from;
  return diff.hunks.some((h) =>
    ref.side === "left"
      ? from <= h.oldStart + h.oldLines - 1 && to >= h.oldStart
      : from <= h.newStart + h.newLines - 1 && to >= h.newStart,
  );
}

export interface CeilingSummary {
  dataset: Dataset;
  instances: number;
  // The tier decides which reviewers run, so it is the cost side of the ceiling.
  byTier: Record<RiskTier, number>;
  references: number;
  byReach: Record<Reachability, number>;
  excludedBy: Record<string, number>;
  byCategory: Record<string, { total: number; reachable: number }>;
}

export function summarizeCeiling(
  dataset: Dataset,
  reaches: readonly ReferenceReach[],
  tiers: readonly RiskTier[],
): CeilingSummary {
  const byTier = Object.fromEntries(RISK_TIERS.map((t) => [t, 0])) as Record<RiskTier, number>;
  for (const t of tiers) byTier[t] += 1;
  const byReach = Object.fromEntries(REACHABILITY_ORDER.map((r) => [r, 0])) as Record<
    Reachability,
    number
  >;
  const excludedBy: Record<string, number> = {};
  const byCategory: Record<string, { total: number; reachable: number }> = {};
  for (const r of reaches) {
    byReach[r.reach] += 1;
    if (r.reach === "file_excluded" && r.detail)
      excludedBy[r.detail] = (excludedBy[r.detail] ?? 0) + 1;
    const c = byCategory[r.category] ?? { total: 0, reachable: 0 };
    byCategory[r.category] = c;
    c.total += 1;
    if (r.reach === "reachable") c.reachable += 1;
  }
  return {
    dataset,
    instances: tiers.length,
    byTier,
    references: reaches.length,
    byReach,
    excludedBy,
    byCategory,
  };
}

const LABEL: Record<Reachability, string> = {
  file_excluded: "File excluded by selection",
  not_in_change: "File not in the change",
  no_reviewer: "No reviewer covers the file",
  out_of_scope: "Out of scope by design (maintainability, readability)",
  no_domain_reviewer: "Security or performance issue without that reviewer",
  outside_diff: "Outside the changed lines",
  reachable: "Reachable",
};

const SCOPE: Record<Dataset, { title: string; count(summary: CeilingSummary): string }> = {
  aacr: {
    title: "AACR-Bench",
    count: (s) => `${s.references} annotated issues in ${s.instances} PR(s)`,
  },
  golden: {
    title: "golden cases",
    count: (s) => `${s.references} expected findings in ${s.instances} case(s)`,
  },
};

export function renderCeiling(summary: CeilingSummary): string {
  const pct = (n: number) =>
    summary.references === 0 ? "0.0" : ((100 * n) / summary.references).toFixed(1);
  const scope = SCOPE[summary.dataset];
  const lines = [
    `# Recall ceiling, ${scope.title}`,
    "",
    `${scope.count(summary)}, classified by ocra's deterministic stages only (no model calls). "Reachable" is an upper bound on recall; issues outside the changed lines can still be found through file context, so the practical bound is between the two.`,
    "",
    `Risk tiers: ${RISK_TIERS.map((t) => `${t} ${summary.byTier[t]}`).join(", ")}.`,
    "",
    "| Reachability | Issues | Share |",
    "|---|---|---|",
    ...REACHABILITY_ORDER.map(
      (r) => `| ${LABEL[r]} | ${summary.byReach[r]} | ${pct(summary.byReach[r])}% |`,
    ),
    "",
    `Upper bound on recall: **${pct(summary.byReach.reachable)}%** reachable, **${pct(summary.byReach.reachable + summary.byReach.outside_diff)}%** counting context outside the changed lines.`,
  ];
  const excluded = Object.entries(summary.excludedBy);
  if (excluded.length > 0) {
    lines.push("", "Excluded files by reason: " + excluded.map(([k, v]) => `${k} ${v}`).join(", "));
  }
  lines.push("", "| Category | Issues | Reachable |", "|---|---|---|");
  for (const [category, c] of Object.entries(summary.byCategory).sort(
    (a, b) => b[1].total - a[1].total,
  )) {
    lines.push(`| ${category} | ${c.total} | ${c.reachable} |`);
  }
  return `${lines.join("\n")}\n`;
}
