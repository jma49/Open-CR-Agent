import { posix } from "node:path";
import type { CodeMatch, ReviewContext } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import { OcraError } from "../errors.js";
import { foldPath, isSecretPath } from "../select/select.js";
import type { VcsAdapter } from "../vcs.js";

export class AccessDeniedError extends OcraError {
  constructor(message: string) {
    super("ACCESS_DENIED", message);
    this.name = "AccessDeniedError";
  }
}

const WINDOWS = process.platform === "win32";

// Agents read the repository through this context only, so the policy lives
// here once instead of in every VCS adapter: no secrets, no git internals,
// nothing outside the repository, whatever a prompt injection asks for.
// Reads are memoized: the revision under review does not change during a run,
// and anchoring and every agent re-read the same files.
export function reviewContext(vcs: VcsAdapter, diffs: readonly FileDiff[]): ReviewContext {
  const reads = new Map<string, Promise<string | undefined>>();
  const searches = new Map<string, Promise<CodeMatch[]>>();
  // A file renamed away from a secret name still holds the secret, and
  // selection already excludes it from review for that reason.
  const renamedSecrets = new Set(
    diffs
      .filter((d) => d.newPath !== d.oldPath && isSecretPath(d.oldPath))
      .map((d) => foldPath(d.newPath)),
  );
  const isReadable = (path: string) => {
    const normalized = normalize(path);
    return (
      normalized !== undefined && isAllowed(normalized) && !renamedSecrets.has(foldPath(normalized))
    );
  };
  const allowedPath = (path: string) => {
    const normalized = normalize(path);
    if (normalized === undefined || !isReadable(normalized)) {
      throw new AccessDeniedError(`Access to ${path} is not allowed`);
    }
    return normalized;
  };
  return {
    async readFile(path) {
      const allowed = allowedPath(path);
      let read = reads.get(allowed);
      if (!read) {
        read = vcs.readFile(allowed);
        reads.set(allowed, read);
        read.catch(() => reads.delete(allowed));
      }
      return read;
    },
    readDiff(path) {
      const allowed = allowedPath(path);
      return diffs.find((d) => d.newPath === allowed || d.oldPath === allowed)?.patch;
    },
    // Agents in parallel often search for the same symbol.
    searchCode(literal) {
      let search = searches.get(literal);
      if (!search) {
        search = vcs
          .searchCode(literal)
          .then((matches) => matches.filter((m: CodeMatch) => isReadable(m.path)));
        searches.set(literal, search);
        search.catch(() => searches.delete(literal));
      }
      return search;
    },
  };
}

// Names are compared folded: a case-insensitive file system opens a file
// under every spelling that folds to its name.
function isAllowed(normalized: string): boolean {
  const segments = foldPath(normalized).split("/");
  return !segments.includes(".git") && !isSecretPath(normalized);
}

function normalize(path: string): string | undefined {
  const unified = posix.normalize(path.replaceAll("\\", "/"));
  if (unified.startsWith("/") || unified === ".." || unified.startsWith("../")) return undefined;
  // On Windows ".env::$DATA", ".env " and 8.3 names such as ENV~1 open the
  // same file as ".env" but match no secret pattern: refuse those forms.
  if (WINDOWS && unified.split("/").some((s) => /[:]|[. ]$|~\d/.test(s))) return undefined;
  return unified.replace(/^\.\//, "");
}
