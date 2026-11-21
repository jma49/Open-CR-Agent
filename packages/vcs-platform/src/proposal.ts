import type { ChangeRequestRef } from "./target.js";

// Files ocra proposes as a change request of their own: the learnings an
// `ocra learn` run wrote back (ADR-0040). Each file is new or replaces the
// one at its path on the base branch.
export interface FileProposal {
  // The branch made for it, from the default branch's head.
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: readonly { path: string; content: string }[];
  // Merge it once its checks pass; off, a person merges it.
  autoMerge: boolean;
}

export interface ProposedChange {
  webUrl: string;
  // enabled: it merges once its checks pass; merged: no check was required,
  // so it was merged at once; off: autoMerge was false; unavailable: the
  // platform refused, and `warnings` says why.
  merge: "enabled" | "merged" | "off" | "unavailable";
  warnings: string[];
}

export interface ProposeOptions {
  env: Readonly<Record<string, string | undefined>>;
  // The repository or project; unset, the platform's environment variables
  // or the origin remote tell.
  repository?: ChangeRequestRef["repository"];
  origin(): Promise<string | undefined>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}
