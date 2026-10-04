import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RiskTier } from "@open-cr-agent/core";
import { type PlanOutput, parseUnifiedDiff } from "@open-cr-agent/core/internal";
import {
  classifyReferences,
  type ReferenceReach,
  renderCeiling,
  summarizeCeiling,
} from "./ceiling.js";
import type { Dataset, Instance } from "./dataset.js";
import { benchmarkEnv, exec } from "./exec.js";
import { untouchedPaths } from "./golden.js";
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
      reaches.push(...classifyReferences(instance, preview, files));
      tiers.push(preview.tier);
      options.log(`${label}: ${instance.references.length} issue(s) classified`);
    } catch (error) {
      const kind = error instanceof UnavailableCommitError ? "unavailable" : "failed";
      options.log(`${label}: ${kind}: ${(error as Error).message.split("\n")[0]}`);
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

async function plan(
  dir: string,
  instance: Instance,
  command: readonly string[],
): Promise<PlanOutput> {
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
  return JSON.parse(result.stdout) as PlanOutput;
}
