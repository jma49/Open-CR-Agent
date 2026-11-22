import { roleCall } from "../agent/settings.js";
import type { Usage } from "../contracts.js";
import type { Finding } from "../domain.js";
import { type FixSummary, proposeFixes } from "../fix/propose.js";
import { DEFAULT_MAX_FIXES } from "../fix/select.js";
import type { CheckStage } from "./check-stage.js";
import type { StageContext } from "./execute-stage.js";

export interface FixStage {
  findings: Finding[];
  // Absent when the stage did not run.
  summary?: FixSummary;
  usage: Usage[];
  warnings: string[];
}

// After the judge, so fixes are asked only for findings the report keeps.
export async function fixStage(
  { judged }: CheckStage,
  { options, settings, plan, spendLimit, signal, emit }: StageContext,
): Promise<FixStage> {
  const findings = judged.findings;
  if (!settings.fixes) return { findings, usage: [], warnings: [] };
  if (!options.syntax) {
    return {
      findings,
      usage: [],
      warnings: ["fixes were asked for, but no syntax checker was given: none was proposed"],
    };
  }
  emit({ type: "stage_started", stage: "fix" });
  const fixed = await proposeFixes(findings, {
    runtime: options.runtime,
    syntax: options.syntax,
    diffs: plan.selected,
    context: plan.context,
    signal,
    concurrency: settings.concurrency,
    maxFixes: DEFAULT_MAX_FIXES,
    spendLimit,
    call: roleCall("fixer", options),
  });
  return {
    findings: fixed.findings,
    summary: fixed.summary,
    usage: fixed.usage,
    warnings: fixed.warnings,
  };
}
