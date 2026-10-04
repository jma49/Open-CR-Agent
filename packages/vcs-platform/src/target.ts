import type { PluginRegistry, VcsAdapter } from "@open-cr-agent/core";
import type { CodeSource, History } from "./review.js";

// A pull or merge request as the user named it.
export interface ChangeRequestRef {
  // The pull request's number, or the merge request's iid.
  number: number;
  // The repository or project; unset, the platform's environment variables
  // or the origin remote tell.
  repository?: string;
}

export interface ResolveTargetOptions {
  ref: ChangeRequestRef;
  env: Readonly<Record<string, string | undefined>>;
  // The checkout's origin remote, read only when the platform needs it.
  origin(): Promise<string | undefined>;
  warn(message: string): void;
  fetch?: typeof fetch;
}

// Where the adapter reads the code under review and the repository's
// history once the change request's commits are in the local clone.
export interface LocalCode {
  code: CodeSource;
  history: History;
}

// A change request found on its platform: which commits to review, and how
// to make the platform's adapter for it. The caller fetches the commits and
// reads trusted inputs from the base; the platform owns its credentials,
// API address and origin rules.
export interface PlatformTarget<Settings> {
  // The VCS adapter's name in the plugin registry.
  platform: string;
  baseSha: string;
  headSha: string;
  // Refspecs that fetch the head when the clone does not have it.
  headRefs: string[];
  // The change request's web page.
  webUrl: string;
  createVcs(
    registry: Pick<PluginRegistry, "createVcs">,
    local: LocalCode,
    settings: Settings,
  ): VcsAdapter;
}
