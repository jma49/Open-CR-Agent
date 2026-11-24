import { z } from "zod";
import { LEARNING_ID, MAX_LEARNINGS } from "./learnings.js";
import {
  MAX_EVIDENCE,
  MAX_EVIDENCE_FIELD,
  MAX_FIELD,
  MAX_FINDINGS,
  MAX_RULE_TEXT,
} from "./limits.js";
import { MAX_MERGE_CHECKS, sharedMergeCheckSchema } from "./merge-checks.js";
import { normaliseRemote, REPOSITORY_URL } from "./repository.js";
import { sharedTraceSchema } from "./trace.js";
import {
  FINGERPRINT,
  REPO_HASH,
  REVIEWER_ID,
  reviewSourceSchema,
  riskTierSchema,
  severitySchema,
  verdictSchema,
  verificationSchema,
} from "./vocabulary.js";

export { FINGERPRINT };

// POST /api/reviews: what a signed-in CLI sends after a review (ADR-0024,
// ADR-0028), and what ocra Cloud answers.
//
// Each schema's input type is what a client sends; its output is what the
// server keeps. Past the identifying fields, a value the server cannot use
// becomes its default instead of refusing the upload, so a newer client (a
// new tier, say) still has its counts kept.

const count = z.number().int().min(0).max(1e12).catch(0);
const costUsd = z.number().min(0).lt(1e6).catch(0);

export const severityCountsSchema = z
  .object({ critical: count, warning: count, suggestion: count })
  .catch({ critical: 0, warning: 0, suggestion: 0 });

export const reviewerCountsSchema = z.object({
  tasks: count,
  failedTasks: count,
  findings: severityCountsSchema,
  costUsd,
  fixed: count,
  dismissed: count,
});
export type ReviewerCounts = z.input<typeof reviewerCountsSchema>;

/** What a finding names as the rule it applies: a repository rule or a learning (ADR-0080). */
export const FINDING_RULE_KINDS = ["rule", "learning"] as const;
/** A rule's or a learning's id, as the review report gives it. */
export const FINDING_RULE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

const line = z.number().int().min(0).lt(10_000_000).nullable().catch(null);
const fixLine = z.number().int().positive().lt(10_000_000);

/**
 * A finding's fix: the replacement of lines startLine to endLine of the
 * reviewed head, which ocra Cloud may commit to the pull request. Sent only
 * as the model wrote it, never redacted or cut, so a commit of it is the
 * fix ocra reported.
 */
export const sharedFixSchema = z
  .object({ startLine: fixLine, endLine: fixLine, replacement: z.string().max(MAX_FIELD) })
  .refine((f) => f.endLine >= f.startLine);
export type SharedFix = z.input<typeof sharedFixSchema>;

/**
 * A finding as the CLI shares it when the account shares findings
 * (ADR-0028, 2): each text field cut at MAX_FIELD and redacted
 * (redactField), which the server does again. One that fails is left out
 * on its own; a longer optional field reads as absent.
 */
export const sharedFindingSchema = z.object({
  fingerprint: z.string().regex(FINGERPRINT),
  reviewer: z.string().regex(REVIEWER_ID),
  severity: severitySchema,
  category: z.string().max(MAX_FIELD).nullable().catch(null),
  verification: verificationSchema.nullable().catch(null),
  file: z.string().min(1).max(1024),
  lineStart: line,
  lineEnd: line,
  title: z.string().max(MAX_FIELD),
  body: z.string().max(MAX_FIELD),
  suggestion: z.string().max(MAX_FIELD).nullable().catch(null),
  code: z.string().max(MAX_FIELD).nullable().catch(null),
  // Added with sharedFixSchema; optional so a server reading older uploads still can.
  fix: sharedFixSchema.optional().catch(undefined),
  // What the reviewer read to reach the finding, one fact per entry; optional as `fix` is.
  evidence: z
    .array(z.string().max(MAX_EVIDENCE_FIELD))
    .max(MAX_EVIDENCE)
    .optional()
    .catch(undefined),
  // The rule or learning the finding applies; the report's provenance holds a rule's text.
  rule: z
    .object({ kind: z.enum(FINDING_RULE_KINDS), id: z.string().regex(FINDING_RULE_ID) })
    .optional()
    .catch(undefined),
  // Kept by --ultra though the judge would drop it; `ocra fix` asks no fix for it.
  lowConfidence: z.literal(true).optional().catch(undefined),
  // Set when the CLI replaced a secret-looking string or cut a long field.
  redacted: z.literal(true).optional().catch(undefined),
  truncated: z.literal(true).optional().catch(undefined),
});
export type SharedFinding = z.input<typeof sharedFindingSchema>;

const outcomeFingerprints = z
  .array(z.string().regex(FINGERPRINT).nullable().catch(null))
  .max(MAX_FINDINGS)
  .optional()
  .catch(undefined);

/** At most this many file groups, and files in each, in a shared walkthrough. */
export const MAX_WALKTHROUGH_GROUPS = 12;
export const MAX_WALKTHROUGH_FILES = 200;

/**
 * The review's walkthrough of the change (ADR-0047), shared with the
 * findings and redacted the same way; one that does not fit reads as absent.
 */
export const sharedWalkthroughSchema = z.object({
  overview: z.string().max(MAX_FIELD),
  groups: z
    .array(
      z.object({
        title: z.string().max(MAX_FIELD),
        files: z.array(z.string().min(1).max(1024)).max(MAX_WALKTHROUGH_FILES),
        note: z.string().max(MAX_FIELD),
      }),
    )
    .max(MAX_WALKTHROUGH_GROUPS),
  diagram: z.string().max(MAX_FIELD).nullable().catch(null),
  redacted: z.literal(true).optional().catch(undefined),
  truncated: z.literal(true).optional().catch(undefined),
});
export type SharedWalkthrough = z.input<typeof sharedWalkthroughSchema>;

/** At most this many linked tasks in an upload, as the engine gives reviewers. */
export const MAX_LINKED_TASKS = 3;
export const LINKED_TASK_TRACKERS = ["github", "gitlab", "jira", "tapd"] as const;

/**
 * A task the change is linked to (ADR-0052): which one and its state with
 * every pull or merge request upload, what it says (title, labels) only
 * with the findings, redacted the same way.
 */
export const sharedLinkedTaskSchema = z.object({
  tracker: z.enum(LINKED_TASK_TRACKERS),
  key: z.string().regex(/^[#&]?[\w.-]{1,64}$/),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional()
    .catch(undefined),
  state: z.enum(["open", "closed"]).nullable().catch(null),
  title: z.string().max(MAX_FIELD).optional().catch(undefined),
  labels: z.array(z.string().max(256)).max(10).optional().catch(undefined),
});
export type SharedLinkedTask = z.input<typeof sharedLinkedTaskSchema>;

/** A repository's path on its host: `owner/name`, or more segments on GitLab. */
const REPO_NAME = /^[\w.-]+(?:\/[\w.-]+)+$/;

/**
 * Which repository a review is of, sent only when the configuration opts
 * in (`cloud.shareRepoName`): its path, and its address in the normalised
 * form the hash is made from, so no user, password or port.
 */
export const sharedRepoSchema = z.object({
  name: z
    .string()
    .max(200)
    .regex(REPO_NAME)
    .refine((name) => name.split("/").every((part) => !/^\.+$/.test(part))),
  url: z
    .string()
    .regex(REPOSITORY_URL)
    .refine((url) => normaliseRemote(url) === url)
    .optional()
    .catch(undefined),
});
export type SharedRepo = z.input<typeof sharedRepoSchema>;

/**
 * The review's counts, and the shared findings in `findingList`. A finding
 * or a reviewer's counts that do not fit read as null; the server keeps
 * the first MAX_FINDINGS findings and the first MAX_REVIEWERS reviewers
 * under a REVIEWER_ID, and answers what it left out as `dropped`.
 */
export const reviewUploadSchema = z.object({
  runId: z.string().regex(/^[\w.-]{1,64}$/),
  repoHash: z.string().regex(REPO_HASH),
  source: reviewSourceSchema,
  tier: riskTierSchema.nullable().catch(null),
  verdict: verdictSchema.nullable().catch(null),
  // As the exit code reads it: incomplete when files went unreviewed or a
  // critical finding could not be verified.
  complete: z.boolean().catch(true),
  findings: severityCountsSchema,
  files: z.object({ reviewed: count, notReviewed: count }).catch({ reviewed: 0, notReviewed: 0 }),
  tasks: z.object({ completed: count, failed: count }).catch({ completed: 0, failed: 0 }),
  usage: z
    .object({ inputTokens: count, outputTokens: count, costUsd })
    .catch({ inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  durationMs: count,
  ocraVersion: z
    .string()
    .regex(/^[\w.+-]{1,32}$/)
    .nullable()
    .catch(null),
  // Added by ADR-0028; optional so a server reading older uploads still can.
  reviewers: z
    .record(z.string(), reviewerCountsSchema.nullable().catch(null))
    .optional()
    .catch(undefined),
  verification: z
    .object({ confirmed: count, uncertain: count, unchecked: count })
    .partial()
    .optional()
    .catch(undefined),
  outcomes: z
    .object({
      fixed: count,
      dismissed: count,
      // Which earlier findings, only with the findings, so ocra Cloud can
      // mark the ones it holds. Absent from older clients.
      fixedFingerprints: outcomeFingerprints,
      dismissedFingerprints: outcomeFingerprints,
    })
    .optional()
    .catch(undefined),
  findingList: z.array(sharedFindingSchema.nullable().catch(null)).optional().catch(undefined),
  walkthrough: sharedWalkthroughSchema.optional().catch(undefined),
  // Absent when the review did not look tasks up; empty when none is linked.
  linkedTasks: z
    .array(sharedLinkedTaskSchema.nullable().catch(null))
    .max(MAX_LINKED_TASKS)
    .optional()
    .catch(undefined),
  // The ids of the learnings its tasks were given (ADR-0037): with a pull or
  // merge request's review, else with the findings. Absent from older clients.
  learnings: z
    .array(z.string().regex(LEARNING_ID).nullable().catch(null))
    .max(MAX_LEARNINGS)
    .optional()
    .catch(undefined),
  // Absent when the review was given no checks; only with a pull or merge request.
  mergeChecks: z
    .array(sharedMergeCheckSchema.nullable().catch(null))
    .max(MAX_MERGE_CHECKS)
    .optional()
    .catch(undefined),
  // A pull or merge request's review: which one, so ocra Cloud can show the
  // verdict on it (ADR-0038).
  pullRequest: z
    .object({
      repository: z.string().regex(REPOSITORY_URL),
      number: z.number().int().positive().lt(1e9),
      headSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/),
    })
    .optional()
    .catch(undefined),
  // Which repository it is, when the configuration shares its name.
  repo: sharedRepoSchema.optional().catch(undefined),
  // How the review came to its findings (ADR-0081): only with the findings.
  trace: sharedTraceSchema.optional().catch(undefined),
  // The text of each rule the shared findings name, by id (ADR-0080),
  // redacted and cut like a finding's fields: only with the findings.
  provenance: z
    .object({
      rules: z
        .record(z.string().regex(FINDING_RULE_ID), z.string().max(MAX_RULE_TEXT))
        .refine((rules) => Object.keys(rules).length <= MAX_FINDINGS),
    })
    .optional()
    .catch(undefined),
});
export type ReviewUpload = z.input<typeof reviewUploadSchema>;

/** What the server took: how many findings it kept, and what it left out. */
export const uploadAnswerSchema = z.object({
  id: z.string().optional().catch(undefined),
  // A retry of a run already uploaded; nothing new was kept.
  duplicate: z.literal(true).optional().catch(undefined),
  findings: z.number().int().positive().optional().catch(undefined),
  truncated: z.literal(true).optional().catch(undefined),
  dropped: z
    .object({ findings: count.optional(), reviewers: count.optional() })
    .optional()
    .catch(undefined),
  // The account holds as many findings as it may; the counts were kept.
  findingsSkipped: z.literal("account_limit").optional().catch(undefined),
});
export type UploadAnswer = z.input<typeof uploadAnswerSchema>;
