import { MAX_FIELD } from "./limits.js";

// Replaces secret-looking tokens in a shared finding (ADR-0028, 2): the CLI
// before the finding leaves the machine, ocra Cloud again on what it
// receives. fixtures/redaction-vectors.json pins what both must catch and
// keep. It catches patterns, not every secret.
//
// Each pattern takes time linear in its input (redact.test.ts times crafted
// runs): a match starts at a literal or a boundary, and a part that could
// rescan a run from each position in it is bounded.

export const REDACTED = "[redacted]";

const PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,32}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(ant-|or-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhttps:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]+/g,
  /\bhttps:\/\/(ptb\.|canary\.)?discord(app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/g,
];

// The password in a URL's userinfo: postgres://user:password@host. The
// match starts at `://`, not at each letter of a scheme.
const USERINFO = /(?<=[a-z0-9+.-])(:\/\/[^\s:/@]*:)([^\s/@]+)@/gi;

// Basic auth on a command line: curl -u user:password, --user user:password.
// Not a reference ($PASS), and not a uid:gid (docker run -u 1000:1000).
const USER_FLAG =
  /(?<![^\s"'`])((?:-u|--user)(?:[ \t]+|=)?["']?)([^\s:"'`()]{0,64}):([^\s"'`$][^\s"'`]{0,255})/g;
const isUidGid = (user: string, value: string) => /^\d+$/.test(user) && /^\d+$/.test(value);

// An HTTP credential however short: Bearer …, Basic …, capitalised as in a
// header. A word after the scheme is prose ("Basic error-handling",
// "Bearer TokenValidation") and stays.
const AUTH_SCHEME = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/-]{8,}=*)/g;
const isWord = (s: string) => /^[A-Z]?[a-z]+(?:[-A-Z][a-z]+)*$/.test(s);

const SECRET_NAME =
  "(?:passw(?:or)?d|passphrase|pwd|secret[_-]?key(?:[_-]?base)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)";

// A quoted value assigned to a name that says it is secret:
// password = "…", "apiKey": "…", DB_PASSWORD: '…'; also one whose closing
// quote a cut at the end of the text left out.
const QUOTED = new RegExp(`(${SECRET_NAME}["']?\\s*[:=]\\s*)(["'\`])([^"'\`\\n]{4,})(\\2|$)`, "gi");

// An unquoted value. One starting like a reference, a template or markup
// ($VAR, ${{ … }}, <…>, {…}, *alias, :symbol, @field) is not a secret.
// Both patterns take it whole, `(?=(…))\2`, so a failed match does not
// retry each shorter value.
const BARE_VALUE = "[^\\s\"'`$%&*!|<>=#~:{[(@\\\\-][^\\s\"'`]{0,255}";
// NAME=value with nothing around the `=`: an environment variable, a flag,
// a query string. The value ends at the next space or quote.
const BARE_ENV = new RegExp(`(${SECRET_NAME}=)(?=(${BARE_VALUE}))\\2(?![^\\s"'\`])`, "gi");
// NAME: value or NAME = value ending its line (YAML, .env, .ini,
// .properties), or before a comment or a closing quote. The spaces after
// it are bounded: several overlapping values may reach the same run.
const BARE_LINE = new RegExp(
  `(${SECRET_NAME}["']?[ \\t]*[:=][ \\t]*)(?=(${BARE_VALUE}))\\2(?=["'\`]|[ \\t]{0,64}(?:[\\r\\n]|$)|[ \\t]{1,64}#)`,
  "gi",
);
// An unquoted value that reads as code: a call, an index or a generic; the
// end of a statement, an argument list or a block; a name or a type
// (letters only: null, string, String!); a dotted reference
// (process.env.TOKEN).
const CODE_VALUE =
  /[([<]|[;,):}\]]$|^[A-Za-z_]+[?!]?$|^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)+$/;
const isBareSecret = (value: string) => value.length >= 4 && !CODE_VALUE.test(value);
// A name after `$` is a reference ($PWD, $DB_PASSWORD), not an assignment.
// Checked on a match, not in the pattern, which would look back from every
// position of the text.
const isReference = (text: string, at: number) =>
  /\$\w{0,64}$/.test(text.slice(Math.max(0, at - 65), at));

// A long hex run with letters and digits: a key or token in hex. Bounded by
// anything but a letter or digit, so a run after `_` (dop_v1_…), which `\b`
// would not split, counts.
const HEX = /(?<![0-9a-z])[0-9a-f]{32,}(?![0-9a-z])/gi;
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
  out = out.replace(USER_FLAG, (m, flag: string, user: string, value: string) =>
    isUidGid(user, value) ? m : `${flag}${user}:${REDACTED}`,
  );
  out = out.replace(AUTH_SCHEME, (m, scheme: string, space: string, value: string) =>
    isWord(value) ? m : `${scheme}${space}${REDACTED}`,
  );
  out = out.replace(
    QUOTED,
    (_m, head: string, open: string, _value: string, close: string) =>
      `${head}${open}${REDACTED}${close}`,
  );
  // NAME=value is shell or .env, where a `;` or `,` after the value ends a
  // command rather than marking code.
  out = out.replace(BARE_ENV, (m, head: string, value: string, at: number, all: string) => {
    const end = /[;,]$/.test(value) ? value.slice(-1) : "";
    const secret = isBareSecret(value.slice(0, value.length - end.length));
    return secret && !isReference(all, at) ? `${head}${REDACTED}${end}` : m;
  });
  out = out.replace(BARE_LINE, (m, head: string, value: string, at: number, all: string) =>
    isBareSecret(value) && !isReference(all, at) ? `${head}${REDACTED}` : m,
  );
  out = out.replace(HEX, (m) => (isHexKey(m) ? REDACTED : m));
  out = out.replace(LONG_RUN, (m) => (looksRandom(m) ? REDACTED : m));
  return { text: out, redacted: out !== text };
}

// How far past the cap a field is read to finish the run of non-space
// characters the cap falls in, so a token cut there is redacted whole
// rather than sent in part. Longer than any token a pattern names.
const RUN_SLACK = 1_024;
const SPACE = /\s/;

/**
 * One text field of a shared finding as it may be sent or kept: cut at
 * `max` characters (MAX_FIELD), then redacted, so the work is bounded by the
 * cap and not by the input. The token the cut falls in is read whole first,
 * and a cut never leaves half of a surrogate pair.
 */
export function redactField(
  value: string,
  max: number = MAX_FIELD,
): { text: string; redacted: boolean; truncated: boolean } {
  let end = value.length;
  if (end > max) {
    const limit = Math.min(end, max + RUN_SLACK);
    end = max;
    while (end < limit && !SPACE.test(value.charAt(end))) end += 1;
  }
  const read = cutAt(value, end);
  const r = redact(read);
  const text = cutAt(r.text, max);
  return {
    text,
    redacted: r.redacted,
    truncated: read.length < value.length || text.length < r.text.length,
  };
}

function cutAt(s: string, n: number): string {
  if (s.length <= n) return s;
  const last = s.charCodeAt(n - 1);
  return s.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}
