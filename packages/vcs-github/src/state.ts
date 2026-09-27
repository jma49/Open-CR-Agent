import type { PriorFinding } from "@open-cr-agent/core";
import { severitySchema, verificationSchema } from "@open-cr-agent/core";
import { z } from "zod";

export const SUMMARY_MARKER = "<!-- ocra:review -->";
// Only a state block that ends the comment counts: author-controlled text
// (file paths, titles) is printed above it and must not be able to plant one.
const STATE_PATTERN = /<!-- ocra:state v1 ([A-Za-z0-9+/=]+) -->\s*$/;
const MAX_STATE_FINDINGS = 500;
const MAX_STATE_CHARS = 60_000;
// Written states stay well under what is read, so the summary text keeps room
// in GitHub's 65,536-character comment limit.
export const MAX_WRITTEN_STATE_CHARS = 30_000;
const MAX_PENDING_FILES = 1_000;
const MAX_POSTED = 1_000;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// What a summary comment remembers of the review that wrote it. `head` is the
// commit it reviewed and `pending` the files it did not finish; together they
// let the next run review only what changed.
export interface ReviewState {
  findings: PriorFinding[];
  head?: string;
  pending?: string[];
  // Inline comments ocra posted for findings that are no longer tracked
  // (refuted, dropped by the judge, low confidence), so a finding that comes
  // back later is not commented twice.
  posted?: string[];
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
  posted: z
    .array(z.string().regex(/^[0-9a-f]{16}$/))
    .max(MAX_POSTED)
    .optional(),
});

// The state lives in a comment anyone with write access can edit, so it is
// validated and bounded, and the adapter ignores it when someone other than
// ocra edited the comment. Dismissals are never stored: they are recomputed
// from review threads on every run.
export function readState(body: string): ReviewState | undefined {
  const encoded = STATE_PATTERN.exec(body)?.[1];
  if (!encoded || encoded.length > MAX_STATE_CHARS) return undefined;
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    if (!parsed.success) return undefined;
    const { head, pending, posted } = parsed.data;
    return {
      findings: parsed.data.findings.map(({ quote, verification, ...finding }) => ({
        ...finding,
        ...(quote ? { quote } : {}),
        ...(verification ? { verification } : {}),
      })),
      ...(head ? { head } : {}),
      ...(pending ? { pending } : {}),
      ...(posted?.length ? { posted } : {}),
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
  // Too large a state first loses its scope (a full review next time), then
  // findings from the end of the list (this run's come first, most severe
  // first); a dropped finding's inline comment may be posted again.
  const posted = state.posted?.length ? { posted: state.posted.slice(-MAX_POSTED) } : {};
  let encoded = encode(kept, { ...scope, ...posted });
  if (encoded.length > MAX_WRITTEN_STATE_CHARS) encoded = encode(kept, posted);
  if (encoded.length > MAX_WRITTEN_STATE_CHARS) encoded = encode(kept, {});
  let count = kept.length;
  while (encoded.length > MAX_WRITTEN_STATE_CHARS && count > 0) {
    count = Math.floor(count * 0.8);
    encoded = encode(kept.slice(0, count), {});
  }
  return `<!-- ocra:state v1 ${encoded} -->`;
}

function encode(findings: unknown[], scope: object): string {
  return Buffer.from(JSON.stringify({ findings, ...scope }), "utf8").toString("base64");
}
