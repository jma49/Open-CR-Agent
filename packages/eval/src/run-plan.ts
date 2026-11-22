// What `ocra-eval run --dry-run` prints: the reviews a run would make and the
// most it may spend, so a paid run's plumbing is checked before it costs.

export interface RunPlan {
  label: string;
  dataset: string;
  tier?: string;
  ids: readonly string[];
  repeat: number;
  // Context sources every review leaves out (ADR-0057).
  without?: readonly string[];
  prMaxCostUsd?: number;
  maxCostUsd?: number;
  models: { top?: string; standard?: string; light?: string };
  judge?: string;
}

export function spendBound(plan: RunPlan): number | undefined {
  if (plan.prMaxCostUsd === undefined) return plan.maxCostUsd;
  const reviews = plan.prMaxCostUsd * plan.ids.length * plan.repeat;
  return plan.maxCostUsd === undefined ? reviews : Math.min(reviews, plan.maxCostUsd);
}

export function renderPlan(plan: RunPlan): string {
  const bound = spendBound(plan);
  const model = (name?: string) => name ?? "unset";
  return `${[
    `# Dry run ${plan.label}`,
    "",
    `Would review ${plan.ids.length} PR(s) of ${plan.dataset}${plan.tier ? ` (tier ${plan.tier})` : ""}, ${plan.repeat} time(s): ${plan.ids.length * plan.repeat} review(s).`,
    "",
    bound === undefined
      ? "Spend bound: none; pass --pr-max-cost-usd or --max-cost-usd before a paid run."
      : `Spend bound: $${bound.toFixed(2)}.`,
    `Models: top ${model(plan.models.top)}, standard ${model(plan.models.standard)}, light ${model(plan.models.light)}.`,
    `Judge: ${plan.judge ?? "unset"}.`,
    ...(plan.without?.length ? [`Left out of every prompt: ${plan.without.join(", ")}.`] : []),
    "",
    ...plan.ids.map((id) => `- ${id}`),
  ].join("\n")}\n`;
}
