import {
  type LiveFinding,
  REVIEW_EVENT_VERSION,
  redactField,
  reviewEventSchema,
  type ReviewEvent as WireEvent,
} from "@open-cr-agent/cloud-contract";
import {
  addUsage,
  emptyUsage,
  type Finding,
  isIncompleteReview,
  type ReviewEvent,
  type ReviewReport,
  type Usage,
} from "@open-cr-agent/core";
import type { LocalTarget } from "@open-cr-agent/vcs-local";

/** How the started event names a local review's target. */
export function targetLabel(target: LocalTarget): string {
  if (target.mode === "range") return `${target.from}..${target.to}`;
  if (target.mode === "commit") return `commit ${target.commit}`;
  return "workspace";
}

type Kinded = Omit<WireEvent, "version" | "runId" | "seq" | "at">;
type FailureReason = Extract<WireEvent, { kind: "failed" }>["data"]["reason"];

/**
 * Turns one run's core events into the contract's, numbered and checked
 * against its schema. Findings are sent again when Verify has checked them
 * and from the report when the run ends, so Verify's and the judge's changes
 * replace what the tasks found.
 */
export class ReviewEventMapper {
  private seq = 0;
  private spent: Usage = emptyUsage();
  private readonly found = new Map<string, LiveFinding>();

  private readonly runId: string;
  private readonly target: string;
  private readonly now: () => number;

  constructor(runId: string, target: string, now: () => number = Date.now) {
    this.runId = runId;
    this.target = target;
    this.now = now;
  }

  map(event: ReviewEvent): WireEvent[] {
    return this.kinds(event).map((kinded) => this.envelope(kinded));
  }

  failed(reason: FailureReason, message?: string): WireEvent {
    const data = message === undefined ? { reason } : { reason, message: bounded(message) };
    return this.envelope({ kind: "failed", data });
  }

  private kinds(event: ReviewEvent): Kinded[] {
    switch (event.type) {
      case "run_started":
        return [{ kind: "started", data: { target: bounded(this.target) } }];
      case "stage_started":
        return [{ kind: "stage", data: { stage: event.stage } }];
      case "task_started":
        return [
          {
            kind: "task.started",
            data: { taskId: event.taskId, reviewer: event.reviewer, files: event.files },
          },
        ];
      case "task_finished":
        return [
          {
            kind: "task.finished",
            data: { taskId: event.outcome.taskId, status: event.outcome.status },
          },
        ];
      case "coverage_settled":
        return event.coverage.map((entry) => ({
          kind: "file.finished",
          data: { path: entry.path, status: entry.status },
        }));
      case "finding": {
        const live = liveFinding(event.finding);
        this.found.set(live.id, live);
        return [{ kind: "finding", data: live }];
      }
      case "findings_verified":
        return this.verified(event);
      case "usage_reported":
        this.spent = addUsage(this.spent, event.usage);
        return [{ kind: "usage", data: this.spent }];
      case "run_finished":
        return this.ending(event.report);
      default:
        return [];
    }
  }

  private verified(event: Extract<ReviewEvent, { type: "findings_verified" }>): Kinded[] {
    const settled = new Set(event.settled);
    const kept = event.kept.map((f): LiveFinding => {
      const live = liveFinding(f);
      return settled.has(f.id) ? { ...live, settled: true } : live;
    });
    for (const live of kept) this.found.set(live.id, live);
    const refuted = event.refuted.flatMap((id): LiveFinding[] => {
      const live = this.found.get(id);
      return live ? [{ ...live, dropped: true }] : [];
    });
    return [...kept, ...refuted].map((data): Kinded => ({ kind: "finding", data }));
  }

  private ending(report: ReviewReport): Kinded[] {
    const kept = new Set(report.findings.map((f) => f.id));
    const findings: Kinded[] = [
      ...report.findings.map(
        (f): Kinded => ({ kind: "finding", data: { ...liveFinding(f), settled: true } }),
      ),
      ...[...this.found.values()]
        .filter((f) => !kept.has(f.id))
        .map((f): Kinded => ({ kind: "finding", data: { ...f, dropped: true } })),
    ];
    return [
      ...findings,
      ...report.warnings.map((w): Kinded => ({ kind: "warning", data: { message: bounded(w) } })),
      {
        kind: "finished",
        data: {
          verdict: report.verdict,
          complete: !isIncompleteReview(report),
          usage: report.usage,
        },
      },
    ];
  }

  private envelope(kinded: Kinded): WireEvent {
    this.seq += 1;
    const at = new Date(this.now()).toISOString();
    return reviewEventSchema.parse({
      version: REVIEW_EVENT_VERSION,
      runId: this.runId,
      seq: this.seq,
      at,
      ...kinded,
    });
  }
}

function liveFinding(f: Finding): LiveFinding {
  const live: LiveFinding = {
    id: f.id,
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    severity: f.severity,
    category: bounded(f.category),
    file: f.file,
    title: bounded(f.title),
    body: bounded(f.body),
  };
  if (f.lineRange) {
    live.lineStart = f.lineRange.start;
    live.lineEnd = f.lineRange.end;
  }
  if (f.suggestion !== undefined) live.suggestion = bounded(f.suggestion);
  if (f.verification) live.verification = f.verification;
  if (f.preExisting) live.preExisting = true;
  return live;
}

const bounded = (text: string) => redactField(text).text;
