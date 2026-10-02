import {
  coverageGaps,
  type Finding,
  type PriorFinding,
  type ReviewReport,
  type Severity,
  serializeOutput,
} from "@open-cr-agent/core";

// `--format sarif`: the review as a SARIF 2.1.0 log, for code scanning and
// security dashboards. One rule per reviewer category, one result per
// finding. Findings an earlier review reported in files this run did not
// review again stay open, so they are results too, marked unchanged.
// https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html

const SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";
const LEVEL: Record<Severity, SarifLevel> = {
  critical: "error",
  warning: "warning",
  suggestion: "note",
};

type SarifLevel = "error" | "warning" | "note";

interface SarifMessage {
  text: string;
}

interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: SarifMessage;
  locations: {
    physicalLocation: {
      artifactLocation: { uri: string; uriBaseId: "%SRCROOT%" };
      region?: { startLine: number; endLine: number };
    };
  }[];
  partialFingerprints: Record<string, string>;
  baselineState?: "new" | "unchanged";
  properties: Record<string, unknown>;
}

export function renderSarif(report: ReviewReport, version: string): string {
  const open = [
    ...(report.rereview?.unchanged ?? []),
    ...(report.rereview?.notReproduced ?? []),
    ...(report.rereview?.notRechecked ?? []),
  ];
  const categories = [
    ...new Set([...report.findings.map((f) => f.category), ...(open.length > 0 ? [CARRIED] : [])]),
  ].sort();
  const index = new Map(categories.map((c, i) => [c, i]));
  const { notReviewed } = coverageGaps(report);
  const log = {
    $schema: SCHEMA,
    version: "2.1.0",
    runs: [
      {
        automationDetails: { id: `ocra/${report.runId}` },
        tool: {
          driver: {
            name: "ocra",
            informationUri: "https://ocra.majincheng.com",
            version,
            semanticVersion: version,
            rules: categories.map((id) => ({
              id,
              name: id,
              shortDescription: {
                text:
                  id === CARRIED
                    ? CARRIED_DESCRIPTION
                    : `Findings of the ${id} reviewer or analyzer`,
              },
              properties: { tags: [id] },
            })),
          },
        },
        invocations: [
          {
            executionSuccessful: notReviewed === 0 && report.unverifiedCriticals === 0,
            toolExecutionNotifications: [
              ...(notReviewed > 0
                ? [
                    {
                      level: "warning",
                      message: { text: `${notReviewed} selected file(s) were not reviewed` },
                    },
                  ]
                : []),
              ...report.warnings.map((w) => ({
                level: "warning",
                message: { text: plainText(w) },
              })),
            ],
          },
        ],
        results: [
          ...report.findings.map((f) => fromFinding(f, index)),
          ...open.map((f) => fromPrior(f, index)),
        ],
        properties: {
          verdict: report.verdict,
          tier: report.tier,
          baseSha: report.changeRequest.baseSha,
          headSha: report.changeRequest.headSha,
          notReviewed: report.coverage
            .filter((c) => c.status === "failed" || c.status === "unreviewed")
            .map((c) => c.path),
          unverifiedCriticals: report.unverifiedCriticals,
          costUsd: report.usage.costUsd,
        },
      },
    ],
  };
  return `${serializeOutput(log)}\n`;
}

// Open findings an earlier review reported, carried over under their own
// rule: their reviewer category is not recorded in the review state.
const CARRIED = "ocra-carried-over";
const CARRIED_DESCRIPTION =
  "Findings an earlier review reported that are still open in files this run did not review again";

function fromFinding(f: Finding, index: ReadonlyMap<string, number>): SarifResult {
  const text = [f.title, f.body, ...(f.suggestion ? [`Suggestion: ${f.suggestion}`] : [])].join(
    "\n\n",
  );
  return {
    ruleId: f.category,
    ruleIndex: index.get(f.category) ?? 0,
    level: LEVEL[f.severity],
    message: { text: plainText(text) },
    locations: [location(f.file, f.lineRange)],
    partialFingerprints: { "ocra/v1": f.fingerprint },
    properties: {
      reviewer: f.reviewer,
      severity: f.severity,
      verification: f.verification ?? "unchecked",
      status: f.status === "unfixed" ? "unfixed" : "new",
      ...(f.lowConfidence ? { lowConfidence: true } : {}),
      task: f.provenance.task,
      ...(f.provenance.model === undefined ? {} : { model: f.provenance.model }),
    },
  };
}

function fromPrior(f: PriorFinding, index: ReadonlyMap<string, number>): SarifResult {
  return {
    ruleId: CARRIED,
    ruleIndex: index.get(CARRIED) ?? 0,
    level: LEVEL[f.severity],
    message: { text: plainText(f.title) },
    // The review state keeps no lines for them, so they apply to the file.
    locations: [location(f.file)],
    partialFingerprints: { "ocra/v1": f.fingerprint },
    baselineState: "unchanged",
    properties: { severity: f.severity, verification: f.verification ?? "unchecked" },
  };
}

function location(file: string, lines?: { start: number; end: number }) {
  return {
    physicalLocation: {
      // Each segment percent-encoded: a path may hold "#", "?" or spaces,
      // which a URI would read as a fragment, a query or an error.
      artifactLocation: {
        uri: file.split("/").map(encodeURIComponent).join("/"),
        uriBaseId: "%SRCROOT%" as const,
      },
      ...(lines ? { region: { startLine: lines.start, endLine: lines.end } } : {}),
    },
  };
}

// SARIF viewers turn "[text](target)" in a message into a link (SARIF
// 3.11.6), and some turn bare web addresses into links too. Text from a
// reviewed change or a model must do neither: every backslash and bracket is
// escaped, backslashes first so a planted "\[" cannot undo the escape, and
// web addresses get a zero-width space in their scheme or after "www", as in
// pull request comments (vcs-platform's safeMarkdown, which also handles
// markup SARIF text does not have). Braces are doubled, since "{0}" is a
// placeholder (SARIF 3.11.5); GitHub shows "{{" as "{".
export function plainText(text: string): string {
  return text
    .replace(/[\\[\]]/g, (c) => `\\${c}`)
    .replace(/[{}]/g, (c) => c + c)
    .replace(/\b(https?|ftp)(?=:\/\/)/gi, "$1​")
    .replace(/\bwww(?=\.)/gi, "www​");
}
