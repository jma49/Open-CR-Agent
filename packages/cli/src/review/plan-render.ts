import type { ReviewPreview } from "@open-cr-agent/core/internal";
import { forTerminal } from "./terminal.js";

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
      `  ${t.taskId.padEnd(width)}  ~${number.format(t.promptTokens)} prompt tokens${t.planPromptTokens === undefined ? "" : ` + plan ~${number.format(t.planPromptTokens)}`}${t.effort === undefined ? "" : `  effort ${t.effort}`}${t.models === undefined ? "" : `  models ${t.models.join(", ")}`}  ${t.bundle}`,
    );
  }
  if (preview.skipped.length > 0) {
    lines.push("", "Skipped by the review matrix:");
    for (const s of preview.skipped) {
      lines.push(`  ${s.reviewer} on ${s.bundle} (${s.reason.replaceAll("_", " ")})`);
    }
  }
  for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);
  lines.push(
    "",
    `First prompts: ~${number.format(preview.promptTokens)} input tokens in total${preview.planCalls > 0 ? `, ${preview.planCalls} plan call(s) included` : ""}. This is a floor: agents read files and take several turns, so a run usually uses several times as much, plus verification and judging. No model was called.`,
  );
  return forTerminal(`${lines.join("\n")}\n`);
}
