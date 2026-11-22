import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@open-cr-agent/core";
import { planChange } from "./ceiling-run.js";
import { type CaseContext, renderContext, summarizeContext } from "./context.js";
import type { Instance } from "./instance.js";
import { prepareRepository, UnavailableCommitError } from "./repos.js";

export interface ContextOptions {
  outDir: string;
  reposDir: string;
  command: readonly string[];
  // Sources left out, as `ocra review --without` takes them.
  without: readonly string[];
  prepare?: (reposDir: string, instance: Instance) => Promise<string>;
  log(message: string): void;
}

// No model is called: `ocra review --plan` counts each task's first prompt
// by source.
export async function measureContext(
  instances: readonly Instance[],
  options: ContextOptions,
): Promise<string> {
  const cases: CaseContext[] = [];
  const extraArgs = options.without.length > 0 ? ["--without", options.without.join(",")] : [];
  for (const [n, instance] of instances.entries()) {
    const label = `[${n + 1}/${instances.length}] ${instance.id}`;
    if (instance.golden?.attack) {
      options.log(`${label}: skipped, an attack plants text in its clean case`);
      continue;
    }
    try {
      const dir = await (options.prepare ?? prepareRepository)(options.reposDir, instance);
      const plan = await planChange(dir, instance, options.command, extraArgs);
      cases.push({ id: instance.id, tasks: plan.tasks });
      options.log(`${label}: ${plan.tasks.length} task(s), ${plan.promptTokens} tokens`);
    } catch (error) {
      const kind = error instanceof UnavailableCommitError ? "unavailable" : "failed";
      options.log(`${label}: ${kind}: ${errorMessage(error).split("\n")[0]}`);
    }
  }
  const summary = summarizeContext(cases);
  const markdown = renderContext(summary, options.without);
  await mkdir(options.outDir, { recursive: true });
  await writeFile(
    join(options.outDir, "context.json"),
    `${JSON.stringify({ summary, cases }, null, 2)}\n`,
  );
  await writeFile(join(options.outDir, "context.md"), markdown);
  return markdown;
}
