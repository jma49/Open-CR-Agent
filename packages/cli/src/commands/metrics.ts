import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isIncompleteReview,
  type ReportOutput,
  type Severity,
  type Verification,
} from "@open-cr-agent/core";
import { serializeOutput } from "@open-cr-agent/core/internal";
import { findRepositoryRoot } from "@open-cr-agent/vcs-local/internal";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { reviewerOutcomes } from "../reviewer-outcomes.js";
import {
  listSessions,
  readSessionReport,
  SESSIONS_DIR,
  sessionStart,
  sessionsDir,
} from "../session/store.js";

const METRICS_VERSION = 1;

const METRICS_USAGE = `Usage: ocra metrics [options]

Counts over the finished reviews in ${SESSIONS_DIR}: runs, cost, findings,
what reviewers later fixed or dismissed, per reviewer. Reads each session's
report.json (report version 1); nothing calls a model.

Options:
  --sessions <dir>     Sessions directory (default: ${SESSIONS_DIR} of this repository)
  --since <date>       Only runs started at or after this ISO 8601 date
  --format <text|json> Output format (default: text); the JSON carries "version": ${METRICS_VERSION}
  -h, --help           Show help
`;

interface ReviewerMetrics {
  tasks: number;
  failedTasks: number;
  findings: number;
  costUsd: number;
  fixed: number;
  dismissed: number;
  // fixed over fixed plus dismissed; null until a finding met either fate.
  acceptanceRate: number | null;
}

export interface Metrics {
  version: typeof METRICS_VERSION;
  sessionsDir: string;
  since?: string;
  runs: {
    total: number;
    byVerdict: Record<string, number>;
    // Incomplete reviews: runs that left a file unfinished (not reviewed,
    // failed, or only partly reviewed) or a critical finding unverified.
    incomplete: number;
    // Sessions without a readable version 1 report: interrupted, or older.
    unreadable: number;
  };
  cost: { usd: number; inputTokens: number; outputTokens: number; usdPerRun: number | null };
  findings: {
    reported: number;
    unique: number;
    bySeverity: Record<Severity, number>;
    byVerification: Record<Verification, number>;
  };
  // Findings an earlier review reported and a later one saw gone from the
  // code (fixed) or dismissed by a reviewer, each fingerprint counted once.
  outcomes: { fixed: number; dismissed: number; acceptanceRate: number | null };
  reviewers: Record<string, ReviewerMetrics>;
}

export async function metricsCommand(argv: string[], out: Output, cwd: string): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    strict: true,
    options: {
      sessions: { type: "string" },
      since: { type: "string" },
      format: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    out.write(METRICS_USAGE);
    return EXIT.ok;
  }
  const format = values.format ?? "text";
  if (format !== "text" && format !== "json") throw new UsageError("--format must be text or json");
  const since = values.since === undefined ? undefined : parseSince(values.since);
  const dir = values.sessions
    ? resolve(cwd, values.sessions)
    : sessionsDir(await findRepositoryRoot(cwd));

  const metrics = await collectMetrics(dir, since);
  out.write(format === "json" ? `${serializeOutput(metrics)}\n` : renderMetrics(metrics));
  return EXIT.ok;
}

function parseSince(text: string): Date {
  const date = new Date(text);
  if (Number.isNaN(date.getTime()))
    throw new UsageError(`--since needs an ISO 8601 date, not "${text}"`);
  return date;
}

export async function collectMetrics(dir: string, since?: Date): Promise<Metrics> {
  // --since compares the start time in each session's id.
  const names = (await listSessions(dir)).filter((n) => {
    const start = sessionStart(n);
    return since === undefined || (start !== undefined && start >= since);
  });
  const reports: ReportOutput[] = [];
  let unreadable = 0;
  for (const name of names) {
    const report = await readSessionReport(join(dir, name));
    if (report) reports.push(report);
    else unreadable += 1;
  }
  return aggregate(reports, {
    sessionsDir: dir,
    unreadable,
    ...(since ? { since: since.toISOString() } : {}),
  });
}

function aggregate(
  reports: readonly ReportOutput[],
  meta: { sessionsDir: string; unreadable: number; since?: string },
): Metrics {
  const byVerdict: Record<string, number> = {};
  const bySeverity: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0 };
  const unique = new Set<string>();
  let incomplete = 0;
  let reported = 0;
  let usd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  for (const report of reports) {
    byVerdict[report.verdict] = (byVerdict[report.verdict] ?? 0) + 1;
    if (isIncompleteReview(report)) incomplete += 1;
    usd += report.usage.costUsd;
    inputTokens += report.usage.inputTokens;
    outputTokens += report.usage.outputTokens;
    for (const finding of report.findings) {
      reported += 1;
      unique.add(finding.fingerprint);
      bySeverity[finding.severity] += 1;
    }
  }
  const outcomes = reviewerOutcomes(reports);
  const reviewers = Object.entries(outcomes.reviewers).map(([id, r]): [string, ReviewerMetrics] => [
    id,
    {
      tasks: r.tasks,
      failedTasks: r.failedTasks,
      findings: r.findings.critical + r.findings.warning + r.findings.suggestion,
      costUsd: r.costUsd,
      fixed: r.fixed,
      dismissed: r.dismissed,
      acceptanceRate: rate(r.fixed, r.dismissed),
    },
  ]);

  return {
    version: METRICS_VERSION,
    sessionsDir: meta.sessionsDir,
    ...(meta.since ? { since: meta.since } : {}),
    runs: { total: reports.length, byVerdict, incomplete, unreadable: meta.unreadable },
    cost: {
      usd,
      inputTokens,
      outputTokens,
      usdPerRun: reports.length > 0 ? usd / reports.length : null,
    },
    findings: {
      reported,
      unique: unique.size,
      bySeverity,
      byVerification: outcomes.verification,
    },
    outcomes: {
      fixed: outcomes.fixed,
      dismissed: outcomes.dismissed,
      acceptanceRate: rate(outcomes.fixed, outcomes.dismissed),
    },
    reviewers: Object.fromEntries(reviewers),
  };
}

function rate(fixed: number, dismissed: number): number | null {
  return fixed + dismissed > 0 ? fixed / (fixed + dismissed) : null;
}

const percent = (value: number | null) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const dollars = (value: number | null) => (value === null ? "n/a" : `$${value.toFixed(2)}`);

function renderMetrics(m: Metrics): string {
  const lines = [
    `Runs: ${m.runs.total}${m.since ? ` since ${m.since}` : ""} (${m.runs.incomplete} incomplete, ${m.runs.unreadable} unreadable)`,
    `  by verdict: ${entries(m.runs.byVerdict)}`,
    `Cost: ${dollars(m.cost.usd)} total, ${dollars(m.cost.usdPerRun)} per run · ${m.cost.inputTokens} in / ${m.cost.outputTokens} out tokens`,
    `Findings: ${m.findings.reported} reported, ${m.findings.unique} unique`,
    `  by severity: ${entries(m.findings.bySeverity)}`,
    `  by verification: ${entries(m.findings.byVerification)}`,
    `Outcomes: ${m.outcomes.fixed} fixed, ${m.outcomes.dismissed} dismissed, acceptance ${percent(m.outcomes.acceptanceRate)}`,
    "",
    "Reviewer           Tasks  Failed  Findings  Cost      Fixed  Dismissed  Acceptance",
  ];
  for (const [id, r] of Object.entries(m.reviewers)) {
    lines.push(
      [
        id.padEnd(18),
        String(r.tasks).padStart(5),
        String(r.failedTasks).padStart(7),
        String(r.findings).padStart(9),
        dollars(r.costUsd).padStart(9),
        String(r.fixed).padStart(6),
        String(r.dismissed).padStart(10),
        percent(r.acceptanceRate).padStart(11),
      ].join(" "),
    );
  }
  return `${forTerminal(lines.join("\n"))}\n`;
}

function entries(record: Record<string, number>): string {
  const parts = Object.entries(record).filter(([, n]) => n > 0);
  return parts.length === 0 ? "none" : parts.map(([k, n]) => `${k} ${n}`).join(", ");
}
