import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createJudge } from "../judges.js";
import { ocraBuild } from "../ocra-build.js";
import { repeatRuns } from "../repeat.js";
import type { RunInfo } from "../report.js";
import { defaultOcraCommand } from "../reviewer.js";
import { runInstances } from "../runner.js";
import { selectInstances } from "../select.js";
import {
  CACHE_DIR,
  dataset,
  loadInstances,
  number,
  type Output,
  parse,
  selection,
} from "./options.js";
import { writeRepeats, writeSummary } from "./summary.js";

export async function run(
  argv: string[],
  out: Output,
  err: Output,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { values } = parse(argv);
  const select = selection(values);
  const name = dataset(values);
  const instances = selectInstances(await loadInstances(name, values), select);
  const runId =
    values.label ??
    new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
  const runDir = resolve(values.out ?? ".ocra/eval", runId);
  const judge = createJudge(values["mock-judge"] === true, env);
  const repeat = number(values.repeat, "--repeat") ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new Error("--repeat must be a whole number from 1");

  // Fixed sampling, so repeated runs differ only by what the provider cannot hold still.
  const sampling = {
    temperature: number(values.temperature, "--temperature") ?? 0,
    seed: number(values["model-seed"], "--model-seed") ?? 1,
  };
  const prMaxCost = number(values["pr-max-cost-usd"], "--pr-max-cost-usd");
  const reviewArgs = [
    ...(values.reviewers ? ["--reviewers", values.reviewers] : []),
    ...(values.ultra ? ["--ultra"] : []),
    // The run limit only stops the next PR; this caps each PR's own review.
    ...(prMaxCost !== undefined ? ["--max-cost-usd", String(prMaxCost)] : []),
    ...(values.config ? ["--config", resolve(values.config)] : []),
    ...["--temperature", String(sampling.temperature), "--seed", String(sampling.seed)],
  ];
  const base = {
    reposDir: values["repos-dir"] ?? join(CACHE_DIR, "repos"),
    command: defaultOcraCommand(),
    timeoutMs: (number(values["timeout-minutes"], "--timeout-minutes") ?? 30) * 60_000,
    log: (message: string) => err.write(`[ocra-eval] ${message}\n`),
    reviewArgs,
    ...(values["retry-failed"] ? { retryFailed: true } : {}),
  };
  const build = await ocraBuild();
  const once = async (dir: string, label: string, maxCostUsd: number | undefined) => {
    await mkdir(dir, { recursive: true });
    const results = await runInstances(instances, {
      ...base,
      runDir: dir,
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    });
    const info: RunInfo = {
      runId: label,
      createdAt: new Date().toISOString(),
      selection: {
        dataset: name,
        ...(name === "golden"
          ? { goldenDir: resolve(values["golden-dir"] ?? "evals/golden") }
          : {}),
        ...select,
      },
      models: {
        top: env.OCRA_MODEL_TOP,
        standard: env.OCRA_MODEL_STANDARD,
        light: env.OCRA_MODEL_LIGHT,
      },
      judge: judge.description,
      review: reviewArgs,
      sampling,
      ocra: build,
    };
    await writeFile(
      join(dir, "run.json"),
      `${JSON.stringify({ info, ids: instances.map((i) => i.id) }, null, 2)}\n`,
    );
    return writeSummary(dir, info, instances, results, judge, runDir);
  };

  const maxCost = number(values["max-cost-usd"], "--max-cost-usd");
  if (repeat === 1) {
    const { markdown } = await once(runDir, runId, maxCost);
    out.write(`${markdown}\nWritten to ${runDir}\n`);
    return 0;
  }
  const runs = await repeatRuns(runDir, repeat, maxCost, base.log, async (dir, n, left) => {
    return (await once(dir, `${runId}/r${n}`, left)).saved;
  });
  return writeRepeats(runDir, runId, runs, out);
}
