import type { PriorFinding } from "@open-cr-agent/core";
import { severitySchema, verificationSchema } from "@open-cr-agent/core";
import { z } from "zod";

export const SUMMARY_MARKER = "<!-- ocra:review -->";
const STATE_PATTERN = /<!-- ocra:state v1 ([A-Za-z0-9+/=]+) -->/;
const MAX_STATE_FINDINGS = 500;
const MAX_STATE_CHARS = 60_000;
const MAX_PENDING_FILES = 1_000;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// What a summary comment remembers of the review that wrote it. `head` is the
// commit it reviewed and `pending` the files it did not finish; together they
// let the next run review only what changed.
export interface ReviewState {
  findings: PriorFinding[];
  head?: string;
  pending?: string[];
}

const stateSchema = z.object({
  findings: z
    .array(
      z.object({
        fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
        title: z.string().max(300),
        file: z.string().max(1_000),
        severity: severitySchema,
        commented: z.boolean(),
        dismissed: z.boolean().optional(),
        quote: z
          .object({
            lines: z.number().int().positive().max(1_000),
            hash: z.string().regex(/^[0-9a-f]{16}$/),
          })
          .optional(),
        verification: verificationSchema.optional(),
      }),
    )
    .max(MAX_STATE_FINDINGS),
  head: z.string().regex(SHA).optional(),
  pending: z.array(z.string().max(1_000)).max(MAX_PENDING_FILES).optional(),
});

// The state lives in a comment anyone with write access can edit, so it is
// validated and bounded. An edit can suppress a repeated comment; the adapter
// does not trust `head` from a comment someone else edited.
export function readState(body: string): ReviewState | undefined {
  const encoded = STATE_PATTERN.exec(body)?.[1];
  if (!encoded || encoded.length > MAX_STATE_CHARS) return undefined;
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    if (!parsed.success) return undefined;
    const { head, pending } = parsed.data;
    return {
      findings: parsed.data.findings.map(({ dismissed, quote, verification, ...finding }) => ({
        ...finding,
        ...(dismissed ? { dismissed } : {}),
        ...(quote ? { quote } : {}),
        ...(verification ? { verification } : {}),
      })),
      ...(head ? { head } : {}),
      ...(pending ? { pending } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeState(state: ReviewState): string {
  const kept = state.findings.slice(0, MAX_STATE_FINDINGS).map((f) => ({
    fingerprint: f.fingerprint,
    title: f.title.slice(0, 300),
    file: f.file.slice(0, 1_000),
    severity: f.severity,
    commented: f.commented,
    ...(f.dismissed ? { dismissed: true } : {}),
    ...(f.quote ? { quote: f.quote } : {}),
    ...(f.verification ? { verification: f.verification } : {}),
  }));
  // Without the full list of unfinished files the next run could skip one of
  // them, so a list that does not fit drops the head and forces a full review.
  const pending = state.pending ?? [];
  const scope =
    state.head && pending.length <= MAX_PENDING_FILES
      ? {
          head: state.head,
          ...(pending.length > 0 ? { pending: pending.map((p) => p.slice(0, 1_000)) } : {}),
        }
      : {};
  const encoded = Buffer.from(JSON.stringify({ findings: kept, ...scope }), "utf8").toString(
    "base64",
  );
  return `<!-- ocra:state v1 ${encoded} -->`;
}
