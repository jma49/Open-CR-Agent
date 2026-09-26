import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage } from "@open-cr-agent/core";
import { type Instance, loadDataset } from "./dataset.js";
import { CachedJudge, judgeConfigFromEnv, MockJudge, OpenAICompatibleJudge } from "./judges.js";
import type { SemanticJudge } from "./match.js";
import { type RunInfo, renderMarkdown } from "./report.js";
import { defaultOcraCommand } from "./reviewer.js";
import { type InstanceResult, runInstances } from "./runner.js";
import { score } from "./score.js";
import { type SelectionOptions, selectInstances } from "./select.js";

interface Output {
  write(chunk: string): unknown;
}

const CACHE_DIR = join(homedir(), ".cache", "ocra", "aacr-bench");

export const USAGE = `Usage: ocra-eval <command> [options]

Commands:
  list                 Show the PRs a selection would review (free)
  run                  Review the selected PRs with ocra, then score them
  score <run-dir>      Re-score an existing run

Selection:
  --limit <n>              Number of PRs (default: all eligible)
  --seed <n>               Sampling seed (default 1)
  --languages <a,b>        Filter by project language
  --max-change-lines <n>   Skip larger PRs
  --ids <a,b>              Exact instance ids

Run:
  --label <name>           Run directory name (default: timestamp); an existing run resumes
  --out <dir>              Runs directory (default .ocra/eval)
  --repos-dir <dir>        Clone cache (default ~/.cache/ocra/aacr-bench/repos)
  --max-cost-usd <n>       Stop starting new PRs once review spend reaches this
  --timeout-minutes <n>    Per-PR timeout (default 30)
  --retry-failed           Review again PRs that failed in an earlier attempt
  --mock-judge             Offline approximate judge (numbers not comparable)

Models come from OCRA_MODEL_TOP / OCRA_MODEL_STANDARD / OCRA_MODEL_LIGHT.
The judge uses JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL, or GEMINI_API_KEY.
`;

export async function main(
  argv: string[],
  out: Output,
  err: Output,
  env = process.env,
): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "list") return await list(rest, out);
    if (command === "run") return await run(rest, out, err, env);
    if (command === "score") return await rescore(rest, out, err, env);
    out.write(USAGE);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  } catch (error) {
    err.write(`ocra-eval: ${errorMessage(error)}\n`);
    return 2;
  }
}

const OPTIONS = {
  limit: { type: "string" },
  seed: { type: "string" },
  languages: { type: "string" },
  "max-change-lines": { type: "string" },
  ids: { type: "string" },
  label: { type: "string" },
  out: { type: "string" },
  "repos-dir": { type: "string" },
  "max-cost-usd": { type: "string" },
  "timeout-minutes": { type: "string" },
  "mock-judge": { type: "boolean" },
  "retry-failed": { type: "boolean" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

function selection(values: ReturnType<typeof parse>["values"]): SelectionOptions {
  const options: SelectionOptions = { seed: number(values.seed, "--seed") ?? 1 };
  const limit = number(values.limit, "--limit");
  const maxChangeLines = number(values["max-change-lines"], "--max-change-lines");
  if (limit !== undefined) options.limit = limit;
  if (maxChangeLines !== undefined) options.maxChangeLines = maxChangeLines;
  if (values.languages) options.languages = values.languages.split(",").map((l) => l.trim());
  if (values.ids) options.ids = values.ids.split(",").map((i) => i.trim());
  return options;
}

async function list(argv: string[], out: Output): Promise<number> {
  const { values } = parse(argv);
  const instances = selectInstances(
    await loadDataset(join(CACHE_DIR, "dataset.json")),
    selection(values),
  );
  for (const i of instances) {
    out.write(
      `${i.id}\t${i.language}\t${i.changeLines} lines\t${i.references.length} issues\t${i.prUrl}\n`,
    );
  }
  const lines = instances.reduce((sum, i) => sum + i.changeLines, 0);
  out.write(
    `${instances.length} PR(s), ${lines} changed lines, ${instances.reduce((s, i) => s + i.references.length, 0)} annotated issues\n`,
  );
  return 0;
}

async function run(
  argv: string[],
  out: Output,
  err: Output,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { values } = parse(argv);
  const select = selection(values);
  const instances = selectInstances(await loadDataset(join(CACHE_DIR, "dataset.json")), select);
  const runId =
    values.label ??
    new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z");
  const runDir = resolve(values.out ?? ".ocra/eval", runId);
  await mkdir(runDir, { recursive: true });
  const judge = createJudge(values["mock-judge"] === true, env);

  const runOptions: Parameters<typeof runInstances>[1] = {
    runDir,
    reposDir: values["repos-dir"] ?? join(CACHE_DIR, "repos"),
    command: defaultOcraCommand(),
    timeoutMs: (number(values["timeout-minutes"], "--timeout-minutes") ?? 30) * 60_000,
    log: (message) => err.write(`[ocra-eval] ${message}\n`),
  };
  const maxCost = number(values["max-cost-usd"], "--max-cost-usd");
  if (maxCost !== undefined) runOptions.maxCostUsd = maxCost;
  if (values["retry-failed"]) runOptions.retryFailed = true;

  const results = await runInstances(instances, runOptions);
  const info: RunInfo = {
    runId,
    createdAt: new Date().toISOString(),
    selection: { ...select },
    models: {
      top: env.OCRA_MODEL_TOP,
      standard: env.OCRA_MODEL_STANDARD,
      light: env.OCRA_MODEL_LIGHT,
    },
    judge: judge.description,
  };
  await writeFile(
    join(runDir, "run.json"),
    `${JSON.stringify({ info, ids: instances.map((i) => i.id) }, null, 2)}\n`,
  );
  return writeSummary(runDir, info, instances, results, judge, out);
}

async function rescore(
  argv: string[],
  out: Output,
  _err: Output,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { values, positionals } = parse(argv);
  const runDir = positionals[0];
  if (!runDir) throw new Error("score needs a run directory");
  const saved = JSON.parse(await readFile(join(runDir, "run.json"), "utf8")) as {
    info: RunInfo;
    ids: string[];
  };
  const all = await loadDataset(join(CACHE_DIR, "dataset.json"));
  const instances = saved.ids
    .map((id) => all.find((i) => i.id === id))
    .filter((i): i is Instance => !!i);
  const results: InstanceResult[] = [];
  for (const id of saved.ids) {
    try {
      results.push(
        JSON.parse(
          await readFile(join(runDir, "instances", `${id}.json`), "utf8"),
        ) as InstanceResult,
      );
    } catch {}
  }
  const judge = createJudge(values["mock-judge"] === true, env);
  return writeSummary(
    runDir,
    { ...saved.info, judge: judge.description },
    instances,
    results,
    judge,
    out,
  );
}

async function writeSummary(
  runDir: string,
  info: RunInfo,
  instances: readonly Instance[],
  results: readonly InstanceResult[],
  judge: JudgeSetup,
  out: Output,
): Promise<number> {
  const cache = new CachedJudge(judge.judge, join(runDir, judge.cacheFile));
  await cache.load();
  const summary = await score(instances, results, cache);
  await cache.save();
  const markdown = renderMarkdown(info, summary);
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify({ info, summary }, null, 2)}\n`);
  await writeFile(join(runDir, "summary.md"), markdown);
  out.write(`${markdown}\nWritten to ${runDir}\n`);
  return 0;
}

interface JudgeSetup {
  judge: SemanticJudge;
  cacheFile: string;
  description: string;
}

function createJudge(mock: boolean, env: NodeJS.ProcessEnv): JudgeSetup {
  if (mock) {
    return {
      judge: new MockJudge(),
      cacheFile: "judge-cache.mock.json",
      description: "mock (word overlap, not comparable)",
    };
  }
  const config = judgeConfigFromEnv(env);
  if (!config)
    throw new Error(
      "No judge configured: set JUDGE_API_KEY or GEMINI_API_KEY, or pass --mock-judge",
    );
  return {
    judge: new OpenAICompatibleJudge(config),
    cacheFile: `judge-cache.${config.model.replace(/[^\w.-]/g, "_")}.json`,
    description: `${config.model} via ${config.baseUrl}`,
  };
}

function number(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}
