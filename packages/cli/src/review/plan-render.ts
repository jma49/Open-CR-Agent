import type { ReviewPreview } from "@open-cr-agent/core/internal";
import { forTerminal } from "../io/terminal.js";

const number = new Intl.NumberFormat("en-US");

export function renderPlan(preview: ReviewPreview): string {
  const lines = [
    `Plan: ${preview.changeRequest.title}`,
    `Risk tier: ${preview.tier} · ${preview.selected.length} selected · ${preview.excluded.length} excluded`,
  ];
  if (preview.excluded.length > 0) {
    lines.push("", "Excluded:");
    for (const e of preview.excluded) lines.push(`  ${e.path}  (${e.reason.replaceAll("_", " ")})`);
  }

  lines.push("", `Bundles: ${preview.bundles.length}`);
  if (preview.groupingSkipped) {
    lines.push("  (shown per file: a real run lets the light model group related files first)");
  }
  preview.bundles.forEach((b, i) => {
    lines.push(
      `  ${i + 1}. ${b.label}${b.files.length > 1 || b.files[0] !== b.label ? `: ${b.files.join(", ")}` : ""}`,
    );
  });

  lines.push("", `Review tasks: ${preview.tasks.length}`);
  const width = Math.max(0, ...preview.tasks.map((t) => t.taskId.length));
  for (const t of preview.tasks) {
    lines.push(
      `  ${t.taskId.padEnd(width)}  ~${number.format(t.promptTokens)} prompt tokens${t.planPromptTokens === undefined ? "" : ` + plan ~${number.format(t.planPromptTokens)}`}${t.effort === undefined ? "" : `  effort ${t.effort}`}${t.models === undefined ? "" : `  models ${t.models.join(", ")}`}${costOf(t.inputCost)}  ${t.bundle}`,
    );
  }
  if (preview.skipped.length > 0) {
    lines.push("", "Skipped by the review matrix:");
    for (const s of preview.skipped) {
      lines.push(`  ${s.reviewer} on ${s.bundle} (${s.reason.replaceAll("_", " ")})`);
    }
  }
  for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);
  if (preview.inputCost) lines.push("", totalCost(preview.inputCost, preview.tasks.length));
  lines.push(
    "",
    `First prompts: ~${number.format(preview.promptTokens)} input tokens in total${preview.planCalls > 0 ? `, ${preview.planCalls} plan call(s) included` : ""}. This is a floor: agents read files and take several turns, so a run usually uses several times as much, plus verification and judging. No model was called.`,
  );
  return forTerminal(`${lines.join("\n")}\n`);
}

type InputCost = NonNullable<ReviewPreview["tasks"][number]["inputCost"]>;

function costOf(cost: InputCost | undefined): string {
  if (cost === undefined) return "";
  if (cost.status === "priced") return `  input ~${usd(cost.usd)}`;
  return cost.status === "unpriced" ? "  input unpriced" : "  input price unknown";
}

function totalCost(total: NonNullable<ReviewPreview["inputCost"]>, tasks: number): string {
  const rest = [
    total.unpriced > 0 ? `${total.unpriced} unpriced` : "",
    total.unknown > 0 ? `${total.unknown} of unknown price` : "",
  ].filter(Boolean);
  return `Estimated input cost: ~${usd(total.usd)} for the first prompts of ${total.priced} of ${tasks} task(s)${rest.length > 0 ? ` (${rest.join(", ")})` : ""}, at the input price of each chain's first model. Input only: output, later turns, verification and judging are not known before the run.`;
}

// Cents hide the size of a small prompt's cost; four decimals keep it.
function usd(value: number): string {
  return `$${value.toFixed(value >= 1 ? 2 : 4)}`;
}
