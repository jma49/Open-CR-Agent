// Replaces secret-looking tokens in a shared finding (ADR-0028, 2): the CLI
// before the finding leaves the machine, ocra Cloud again on what it
// receives. fixtures/redaction-vectors.json pins what both must catch and
// keep. It catches patterns, not every secret.

export const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-(ant-|or-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhttps:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
  /\bhttps:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
];

// The password in a URL's userinfo: postgres://user:password@host.
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s/@]+)@/gi;

// A quoted value assigned to a name that says it is secret:
// password = "…", "apiKey": "…", DB_PASSWORD: '…'.
const ASSIGNED =
  /\b([A-Za-z0-9_.-]*(?:passw(?:or)?d|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)["']?\s*[:=]\s*)(["'`])([^"'`\n]{4,})\2/gi;

// A long hex run with letters and digits: a key or token in hex.
const HEX = /\b[0-9a-f]{32,}\b/gi;
const isHexKey = (s: string) => /[0-9]/.test(s) && /[a-f]/i.test(s);

// A long base64-like run that looks random: high entropy and a digit.
// Identifiers stay under the entropy bar; a path or URL path (every segment
// lowercase, or letters only) is left alone.
const LONG_RUN = /[A-Za-z0-9+/_-]{32,}={0,2}/g;
function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits;
}
const isPath = (s: string) =>
  s.includes("/") &&
  s.split("/").every((seg) => /^[a-z0-9_-]*$/.test(seg) || /^[A-Za-z]+$/.test(seg));
const looksRandom = (s: string) => /\d/.test(s) && entropy(s) >= 4.3 && !isPath(s);

/** The text with secret-looking tokens replaced, and whether any was. */
export function redact(text: string): { text: string; redacted: boolean } {
  let out = text;
  for (const p of PATTERNS) out = out.replace(p, REDACTED);
  out = out.replace(USERINFO, (_m, head: string) => `${head}${REDACTED}@`);
  out = out.replace(ASSIGNED, (_m, head: string, q: string) => `${head}${q}${REDACTED}${q}`);
  out = out.replace(HEX, (m) => (isHexKey(m) ? REDACTED : m));
  out = out.replace(LONG_RUN, (m) => (looksRandom(m) ? REDACTED : m));
  return { text: out, redacted: out !== text };
}
