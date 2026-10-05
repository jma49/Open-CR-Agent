import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CliPlanOutput, cliPlanOutputSchema } from "@open-cr-agent/cli/internal";
import type { RiskTier } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core";
import { parseUnifiedDiff } from "@open-cr-agent/core/internal";
import {
  classifyReferences,
  type ReferenceReach,
  renderCeiling,
  summarizeCeiling,
} from "./ceiling.js";
import { benchmarkEnv, exec } from "./exec.js";
import { untouchedPaths } from "./golden.js";
import type { Dataset, Instance } from "./instance.js";
import { prepareRepository, UnavailableCommitError } from "./repos.js";

export interface CeilingOptions {
  dataset: Dataset;
  outDir: string;
  reposDir: string;
  command: readonly string[];
  prepare?: (reposDir: string, instance: Instance) => Promise<string>;
  log(message: string): void;
}

// No model is called: ocra review --plan shows what the deterministic stages
// decide, and git shows which lines the change touches.
export async function measureCeiling(
  instances: readonly Instance[],
  options: CeilingOptions,
): Promise<string> {
  const reaches: ReferenceReach[] = [];
  const tiers: RiskTier[] = [];
  for (const [n, instance] of instances.entries()) {
    const label = `[${n + 1}/${instances.length}] ${instance.id}`;
    if (instance.golden?.attack) {
      options.log(`${label}: skipped, an attack is classified through its clean case`);
      continue;
    }
    try {
      const classified = await classifyChange(instance, options);
      reaches.push(...classified.reaches);
      tiers.push(classified.tier);
      options.log(`${label}: ${instance.references.length} issue(s) classified`);
    } catch (error) {
      const kind = error instanceof UnavailableCommitError ? "unavailable" : "failed";
      options.log(`${label}: ${kind}: ${errorMessage(error).split("\n")[0]}`);
    }
  }

  const summary = summarizeCeiling(options.dataset, reaches, tiers);
  const markdown = renderCeiling(summary);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(
    join(options.outDir, "ceiling.json"),
    `${JSON.stringify({ summary, reaches }, null, 2)}\n`,
  );
  await writeFile(join(options.outDir, "ceiling.md"), markdown);
  return markdown;
}

export interface ClassifiedChange {
  // The clone the change was classified in, checked out at the head.
  dir: string;
  // One per reference of the instance, in their order.
  reaches: ReferenceReach[];
  tier: RiskTier;
}

export async function classifyChange(
  instance: Instance,
  options: Pick<CeilingOptions, "reposDir" | "command" | "prepare">,
): Promise<ClassifiedChange> {
  const dir = await (options.prepare ?? prepareRepository)(options.reposDir, instance);
  const preview = await plan(dir, instance, options.command);
  const diff = await exec(
    "git",
    [
      "-c",
      "core.quotepath=true",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--end-of-options",
      `${instance.baseCommit}...${instance.headCommit}`,
      "--",
    ],
    { cwd: dir },
  );
  if (diff.exitCode !== 0) throw new Error(`git diff failed: ${diff.stderr.trim()}`);
  const files = parseUnifiedDiff(diff.stdout);
  const untouched = untouchedPaths(instance, new Set(files.map((f) => f.newPath)));
  if (untouched.length > 0) {
    throw new Error(`the case names files the change does not touch: ${untouched.join(", ")}`);
  }
  return { dir, reaches: classifyReferences(instance, preview, files), tier: preview.tier };
}

async function plan(
  dir: string,
  instance: Instance,
  command: readonly string[],
): Promise<CliPlanOutput> {
  const [bin, ...prefix] = command;
  if (!bin) throw new Error("ocra command is empty");
  const result = await exec(
    bin,
    [
      ...prefix,
      "review",
      "--plan",
      "--format",
      "json",
      "--no-repo-config",
      "--from",
      instance.baseCommit,
      "--to",
      instance.headCommit,
    ],
    { cwd: dir, timeoutMs: 5 * 60_000, env: benchmarkEnv() },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `exit ${result.exitCode}`);
  return cliPlanOutputSchema.parse(JSON.parse(result.stdout));
}
