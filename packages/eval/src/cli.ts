import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { errorMessage, proxiedFetch } from "@open-cr-agent/core";
import { applyLabels, LABELS_FILE, labelsFor, readLabels } from "./adjudicate.js";
import { scoreAttacks } from "./attack-score.js";
import { measureCeiling } from "./ceiling-run.js";
import {
  compareSummaries,
  comparisonWarnings,
  renderComparison,
  type SavedSummary,
} from "./compare.js";
import { type Dataset, type Instance, loadDataset } from "./dataset.js";
import { loadGolden, readJson } from "./golden.js";
import { scoreGolden } from "./golden-score.js";
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
  ceiling              Recall ceiling of the deterministic stages (free, no model)
  run                  Review the selected PRs with ocra, then score them
  score <run-dir>      Re-score an existing run
  adjudicate <run-dir> Record the labels typed into a golden run's adjudication.json in its cases
  compare <baseline-run> <run> [--spread-of <second-baseline-run>]
                       Difference per metric; within the baselines' spread it is "no change"

Selection:
  --limit <n>              Number of PRs (default: all eligible)
  --seed <n>               Sampling seed (default 1)
  --languages <a,b>        Filter by project language
  --max-change-lines <n>   Skip larger PRs
  --ids <a,b>              Exact instance ids
  --dataset <aacr|golden>  AACR-Bench (default) or ocra's golden cases (ADR-0011)
  --golden-dir <dir>       Golden case files (default evals/golden; score and
                           adjudicate default to the run's own)
  --tier <smoke|full|adversarial>
                           Golden cases only: the smoke tier, every case, or
                           the attacks with the cases they attack

Run:
  --label <name>           Run directory name (default: timestamp); an existing run resumes
  --out <dir>              Runs directory (default .ocra/eval)
  --repos-dir <dir>        Clone cache (default ~/.cache/ocra/aacr-bench/repos)
  --max-cost-usd <n>       Stop starting new PRs once review spend reaches this
  --pr-max-cost-usd <n>    Spend limit per PR, passed to ocra review --max-cost-usd
  --timeout-minutes <n>    Per-PR timeout (default 30)
  --retry-failed           Review again PRs that failed in an earlier attempt
  --reviewers <ids>        Passed to ocra review --reviewers
  --ultra                  Passed to ocra review --ultra (recall mode; about twice the cost)
  --config <file>          Passed to ocra review --config: your own configuration
                           (declared providers, limits) for reviews that run with
                           --no-repo-config
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
    if (command === "ceiling") return await ceiling(rest, out, err);
    if (command === "run") return await run(rest, out, err, env);
    if (command === "score") return await rescore(rest, out, err, env);
    if (command === "adjudicate") return await adjudicate(rest, out);
    if (command === "compare") return await compare(rest, out);
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
  dataset: { type: "string" },
  "golden-dir": { type: "string" },
  tier: { type: "string" },
  label: { type: "string" },
  out: { type: "string" },
  "repos-dir": { type: "string" },
  "max-cost-usd": { type: "string" },
  "pr-max-cost-usd": { type: "string" },
  "timeout-minutes": { type: "string" },
  "mock-judge": { type: "boolean" },
  "retry-failed": { type: "boolean" },
  reviewers: { type: "string" },
  ultra: { type: "boolean" },
  config: { type: "string" },
  "spread-of": { type: "string" },
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
  if (values.tier !== undefined) {
    if (values.tier !== "smoke" && values.tier !== "full" && values.tier !== "adversarial") {
      throw new Error("--tier must be smoke, full or adversarial");
    }
    if (dataset(values) !== "golden") throw new Error("--tier needs --dataset golden");
    options.tier = values.tier;
  }
  return options;
}

function dataset(values: { dataset?: string | undefined }): Dataset {
  const name = values.dataset ?? "aacr";
  if (name !== "aacr" && name !== "golden") throw new Error("--dataset must be aacr or golden");
  return name;
}

function loadInstances(
  name: Dataset,
  values: { "golden-dir"?: string | undefined },
): Promise<Instance[]> {
  return name === "golden"
    ? loadGolden(resolve(values["golden-dir"] ?? "evals/golden"))
    : loadDataset(join(CACHE_DIR, "dataset.json"), proxiedFetch(process.env));
}

async function list(argv: string[], out: Output): Promise<number> {
  const { values } = parse(argv);
  const select = selection(values);
  const instances = selectInstances(await loadInstances(dataset(values), values), select);
  for (const i of instances) {
    const attack = i.golden?.attack;
    const size = !i.golden
      ? `${i.changeLines} lines`
      : attack
        ? `${i.golden.tier}\t${attack.goal} via ${attack.channel}, on ${attack.on}`
        : `${i.golden.tier}\t${i.golden.clean ? "clean" : `${i.golden.forbid.length} forbidden`}`;
    out.write(`${i.id}\t${i.language}\t${size}\t${i.references.length} issues\t${i.prUrl}\n`);
  }
  const issues = instances.reduce((s, i) => s + i.references.length, 0);
  const lines = instances.reduce((sum, i) => sum + i.changeLines, 0);
  out.write(
    dataset(values) === "golden"
      ? `${instances.length} case(s), ${issues} expected finding(s)\n`
      : `${instances.length} PR(s), ${lines} changed lines, ${issues} annotated issues\n`,
  );
  return 0;
}

async function ceiling(argv: string[], out: Output, err: Output): Promise<number> {
  const { values } = parse(argv);
  const select = selection(values);
  const name = dataset(values);
  const instances = selectInstances(await loadInstances(name, values), select);
  const outDir = resolve(values.out ?? ".ocra/eval", values.label ?? "ceiling");
  const markdown = await measureCeiling(instances, {
    dataset: name,
    outDir,
    reposDir: values["repos-dir"] ?? join(CACHE_DIR, "repos"),
    command: defaultOcraCommand(),
    log: (message) => err.write(`[ocra-eval] ${message}\n`),
  });
  out.write(`${markdown}\nWritten to ${outDir}\n`);
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
  const name = dataset(values);
  const instances = selectInstances(await loadInstances(name, values), select);
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
  // The run limit only stops the next PR; this caps each PR's own review.
  const prMaxCost = number(values["pr-max-cost-usd"], "--pr-max-cost-usd");
  const reviewArgs = [
    ...(values.reviewers ? ["--reviewers", values.reviewers] : []),
    ...(values.ultra ? ["--ultra"] : []),
    ...(prMaxCost !== undefined ? ["--max-cost-usd", String(prMaxCost)] : []),
    ...(values.config ? ["--config", resolve(values.config)] : []),
  ];
  if (reviewArgs.length > 0) runOptions.reviewArgs = reviewArgs;

  const results = await runInstances(instances, runOptions);
  const info: RunInfo = {
    runId,
    createdAt: new Date().toISOString(),
    selection: {
      dataset: name,
      ...(name === "golden" ? { goldenDir: resolve(values["golden-dir"] ?? "evals/golden") } : {}),
      ...select,
    },
    models: {
      top: env.OCRA_MODEL_TOP,
      standard: env.OCRA_MODEL_STANDARD,
      light: env.OCRA_MODEL_LIGHT,
    },
    judge: judge.description,
    ...(reviewArgs.length > 0 ? { review: reviewArgs } : {}),
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
  // run.json is a file on disk like any other: its ids become paths below.
  const bad = saved.ids.find((id) => !/^[\w.@-]+$/.test(id) || id.startsWith("."));
  if (bad !== undefined) throw new Error(`run.json lists an invalid id "${bad}"`);
  const savedDir = saved.info.selection.goldenDir;
  const goldenDir = values["golden-dir"]
    ? resolve(values["golden-dir"])
    : typeof savedDir === "string"
      ? savedDir
      : undefined;
  const all = await loadInstances(saved.info.selection.dataset === "golden" ? "golden" : "aacr", {
    "golden-dir": goldenDir,
  });
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
    {
      ...saved.info,
      // adjudicate writes labels where the cases were read from.
      selection: { ...saved.info.selection, ...(goldenDir ? { goldenDir } : {}) },
      judge: judge.description,
    },
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
  const summary: SavedSummary["summary"] = await score(instances, results, cache);
  const goldenDir = info.selection.goldenDir;
  if (typeof goldenDir === "string") {
    summary.golden = await scoreGolden(instances, results, cache);
    const attacks = await scoreAttacks(instances, results, cache);
    if (attacks) summary.attacks = attacks;
    const labels = labelsFor(goldenDir, summary.golden.unadjudicated, await readLabels(runDir));
    await writeFile(join(runDir, LABELS_FILE), `${JSON.stringify(labels, null, 2)}\n`);
  }
  await cache.save();
  const markdown = renderMarkdown(info, summary);
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify({ info, summary }, null, 2)}\n`);
  await writeFile(join(runDir, "summary.md"), markdown);
  out.write(`${markdown}\nWritten to ${runDir}\n`);
  return 0;
}

async function adjudicate(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const runDir = positionals[0];
  if (!runDir) throw new Error("adjudicate needs a run directory");
  const labels = await readLabels(runDir);
  if (!labels)
    throw new Error(`${join(runDir, LABELS_FILE)} does not exist; is this a golden run?`);
  const result = await applyLabels(labels, values["golden-dir"] ?? labels.goldenDir);
  out.write(
    `${result.applied} label(s) recorded, ${result.alreadyRecorded} already recorded, ${result.pending} still unlabeled\n`,
  );
  return 0;
}

async function compare(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [baselineDir, runDir] = positionals;
  if (!baselineDir || !runDir) throw new Error("compare needs a baseline run and a run");
  const load = async (dir: string) => ({
    summary: (await readJson(join(dir, "summary.json"))) as SavedSummary,
    ids: ((await readJson(join(dir, "run.json"))) as { ids: string[] }).ids,
  });
  const baseline = await load(baselineDir);
  const run = await load(runDir);
  const other = values["spread-of"] ? await load(values["spread-of"]) : undefined;
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  const warnings = [
    ...(same(baseline.ids, run.ids) ? [] : ["the runs reviewed different PRs"]),
    ...(other && !same(baseline.ids, other.ids) ? ["the baselines reviewed different PRs"] : []),
    ...comparisonWarnings([baseline.summary, run.summary, ...(other ? [other.summary] : [])]),
  ];
  out.write(
    renderComparison(compareSummaries(baseline.summary, run.summary, other?.summary), warnings),
  );
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
    judge: new OpenAICompatibleJudge(config, proxiedFetch(env)),
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
