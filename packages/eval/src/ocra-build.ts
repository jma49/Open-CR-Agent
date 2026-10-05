import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_AGENT_STEPS } from "@open-cr-agent/core";
import { z } from "zod";
import { type ExecResult, exec } from "./exec.js";
import { ocraCliRoot } from "./reviewer.js";

// Which ocra a run reviewed with. Each report records the version, but runs
// of one version can differ in their commit and step cap, and a run's
// numbers mean little without them. The cap is read from the same build of
// core the CLI runs.
export const ocraBuildSchema = z.strictObject({
  version: z.string(),
  // The commit of the checkout the CLI was built from, and whether that
  // checkout had changes not committed; absent for an installed CLI.
  commit: z.string().exactOptional(),
  dirty: z.boolean().exactOptional(),
  maxAgentSteps: z.int(),
});
export type OcraBuild = z.output<typeof ocraBuildSchema>;

type Git = (args: readonly string[]) => Promise<ExecResult>;

export async function ocraBuild(
  root = ocraCliRoot(),
  git: Git = (args) => exec("git", ["-C", root, ...args]),
): Promise<OcraBuild> {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  const build: OcraBuild = { version, maxAgentSteps: MAX_AGENT_STEPS };
  const head = await git(["rev-parse", "--verify", "HEAD"]);
  if (head.exitCode !== 0) return build;
  const status = await git(["status", "--porcelain"]);
  return {
    ...build,
    commit: head.stdout.trim(),
    ...(status.exitCode === 0 ? { dirty: status.stdout.trim() !== "" } : {}),
  };
}

export function renderBuild(build: OcraBuild): string {
  const at = build.commit === undefined ? "" : ` at ${build.commit.slice(0, 12)}`;
  const dirty = build.dirty ? " with uncommitted changes" : "";
  return `${build.version}${at}${dirty}, ${build.maxAgentSteps} steps per review agent`;
}
