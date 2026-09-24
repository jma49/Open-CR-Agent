import type { Usage } from "../contracts.js";
import type { ChangeRequest, Finding, RiskTier } from "../domain.js";
import type { ExclusionReason } from "../select/select.js";

export type CoverageEntry =
  | { path: string; status: "reviewed" | "failed" }
  | { path: string; status: "excluded"; reason: ExclusionReason };

export type TaskStatus = "completed" | "failed" | "timed_out" | "cancelled";

export interface TaskOutcome {
  taskId: string;
  reviewer: string;
  bundle: string;
  files: string[];
  status: TaskStatus;
  error?: string;
  findings: number;
  durationMs: number;
}

export interface ReviewReport {
  changeRequest: ChangeRequest;
  tier: RiskTier;
  coverage: CoverageEntry[];
  bundles: { label: string; files: string[] }[];
  tasks: TaskOutcome[];
  findings: Finding[];
  usage: Usage;
  warnings: string[];
}

export type ReviewEvent =
  | { type: "run_started"; changeRequest: ChangeRequest }
  | { type: "files_selected"; selected: number; excluded: number; tier: RiskTier }
  | { type: "files_bundled"; strategy: string; bundles: number; warnings: string[] }
  | { type: "task_started"; taskId: string; reviewer: string; bundle: string; files: string[] }
  | { type: "task_progress"; taskId: string; message: string }
  | { type: "finding"; taskId: string; finding: Finding }
  | { type: "task_finished"; outcome: TaskOutcome }
  | { type: "run_finished"; report: ReviewReport };
