import type { FileDiff, RiskTier } from "./domain.js";

interface TriagePolicy {
  trivialMaxLines: number;
  liteMaxLines: number;
  maxFilesBeforeFull: number;
  sensitivePathPatterns: RegExp[];
  // Matched against whole words of every path segment, so "auth" does not
  // match "author" and "acl" does not match "oracle".
  sensitivePathWords: ReadonlySet<string>;
}

const defaultTriagePolicy: TriagePolicy = {
  trivialMaxLines: 10,
  liteMaxLines: 100,
  maxFilesBeforeFull: 20,
  sensitivePathPatterns: [/(^|\/)\.github\/workflows\//],
  // "token" and "session" are left out: lexers, parsers, tool and log
  // sessions use them far more often than authentication does, and a false
  // match costs a full-tier review.
  sensitivePathWords: new Set([
    "auth",
    "authn",
    "authz",
    "authentication",
    "authorization",
    "oauth",
    "saml",
    "sso",
    "jwt",
    "crypto",
    "security",
    "identity",
    "password",
    "passwords",
    "passwd",
    "credential",
    "credentials",
    "secret",
    "secrets",
    "login",
    "permission",
    "permissions",
    "acl",
    "acls",
  ]),
};

export function triage(diffs: readonly FileDiff[], policy = defaultTriagePolicy): RiskTier {
  const touchesSensitivePath = diffs.some(
    (d) => isSensitivePath(d.newPath, policy) || isSensitivePath(d.oldPath, policy),
  );
  if (touchesSensitivePath || diffs.length > policy.maxFilesBeforeFull) return "full";

  const churn = diffs.reduce((sum, d) => sum + d.additions + d.deletions, 0);
  if (churn <= policy.trivialMaxLines) return "trivial";
  if (churn <= policy.liteMaxLines) return "lite";
  return "full";
}

function isSensitivePath(path: string, policy: TriagePolicy): boolean {
  return (
    policy.sensitivePathPatterns.some((p) => p.test(path)) ||
    pathWords(path).some((w) => policy.sensitivePathWords.has(w))
  );
}

// "src/OAuth2/PasswordHasher.cs" -> o, auth, 2, password, hasher, cs
function pathWords(path: string): string[] {
  return (path.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((w) => w.toLowerCase());
}
