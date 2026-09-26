import { posix } from "node:path";
import type { CodeMatch, ReviewContext, VcsAdapter } from "../contracts.js";
import type { FileDiff } from "../domain.js";
import { isSecretPath } from "../select/select.js";

export class AccessDeniedError extends Error {}

// Agents read the repository through this context only, so the policy lives
// here once instead of in every VCS adapter: no secrets, no git internals,
// nothing outside the repository, whatever a prompt injection asks for.
// Reads are memoized: the revision under review does not change during a run,
// and anchoring and every agent re-read the same files.
export function reviewContext(vcs: VcsAdapter, diffs: readonly FileDiff[]): ReviewContext {
  const reads = new Map<string, Promise<string | undefined>>();
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
    async searchCode(literal) {
      const matches = await vcs.searchCode(literal);
      return matches.filter((m: CodeMatch) => isReadable(m.path));
    },
  };
}

function allowedPath(path: string): string {
  const normalized = normalize(path);
  if (normalized === undefined || !isReadable(normalized)) {
    throw new AccessDeniedError(`Access to ${path} is not allowed`);
  }
  return normalized;
}

function isReadable(path: string): boolean {
  const normalized = normalize(path);
  if (normalized === undefined) return false;
  const segments = normalized.toLowerCase().split("/");
  return !segments.includes(".git") && !isSecretPath(normalized);
}

function normalize(path: string): string | undefined {
  const unified = posix.normalize(path.replaceAll("\\", "/"));
  if (unified.startsWith("/") || unified === ".." || unified.startsWith("../")) return undefined;
  return unified.replace(/^\.\//, "");
}
