import type { OcraPlugin } from "@open-cr-agent/core";
import type { CloudDeps } from "../../cloud/deps.js";
import type { NpmRunner } from "../../plugins/npm.js";
import type { RuntimeLoaders } from "./runtimes.js";

export interface ReviewDeps {
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  builtinPlugins: readonly OcraPlugin[];
  runtimes: RuntimeLoaders;
  now(): number;
  heartbeatMs: number;
  // Only tests replace it, to fake the GitHub and GitLab APIs.
  fetch?: typeof fetch;
  // ocra Cloud: the signed-in session, default models and the upload. Absent,
  // a review never reads a session or contacts ocra Cloud.
  cloud?: CloudDeps;
  // Runs npm for `ocra plugins`; only tests replace it.
  npm?: NpmRunner;
  // This machine's key that seals session logs, so --resume reuses only what
  // ocra wrote here (ADR-0031). Absent, sessions are not sealed and cannot be
  // resumed.
  sessionKey?(): Promise<string>;
  // Calls the handler on Ctrl-C or SIGTERM; returns a function that stops listening.
  onInterrupt?(handler: () => void): () => void;
}
