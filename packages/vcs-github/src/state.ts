import type { PriorFinding } from "@open-cr-agent/core";
import { severitySchema } from "@open-cr-agent/core";
import { z } from "zod";

export const SUMMARY_MARKER = "<!-- ocra:review -->";
const STATE_PATTERN = /<!-- ocra:state v1 ([A-Za-z0-9+/=]+) -->/;
const MAX_STATE_FINDINGS = 500;
const MAX_STATE_CHARS = 60_000;

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
      }),
    )
    .max(MAX_STATE_FINDINGS),
});

// The state lives in a comment anyone with write access can edit, so it is
// validated and bounded; at worst an edit suppresses a repeated comment.
export function readState(body: string): PriorFinding[] | undefined {
  const encoded = STATE_PATTERN.exec(body)?.[1];
  if (!encoded || encoded.length > MAX_STATE_CHARS) return undefined;
  try {
    const parsed = stateSchema.safeParse(
      JSON.parse(Buffer.from(encoded, "base64").toString("utf8")),
    );
    if (!parsed.success) return undefined;
    return parsed.data.findings.map(({ dismissed, ...finding }) =>
      dismissed ? { ...finding, dismissed } : finding,
    );
  } catch {
    return undefined;
  }
}

export function writeState(findings: readonly PriorFinding[]): string {
  const kept = findings.slice(0, MAX_STATE_FINDINGS).map((f) => ({
    fingerprint: f.fingerprint,
    title: f.title.slice(0, 300),
    file: f.file.slice(0, 1_000),
    severity: f.severity,
    commented: f.commented,
    ...(f.dismissed ? { dismissed: true } : {}),
  }));
  const encoded = Buffer.from(JSON.stringify({ findings: kept }), "utf8").toString("base64");
  return `<!-- ocra:state v1 ${encoded} -->`;
}
