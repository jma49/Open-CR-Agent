import { errorMessage } from "@open-cr-agent/core";
import { adjudicate } from "./commands/adjudicate.js";
import { ceiling } from "./commands/ceiling.js";
import { compare } from "./commands/compare.js";
import { goldenImport } from "./commands/golden-import.js";
import { list } from "./commands/list.js";
import type { Output } from "./commands/options.js";
import { run } from "./commands/run.js";
import { rescore } from "./commands/score.js";
import { trend } from "./commands/trend.js";

const USAGE = `Usage: ocra-eval <command> [options]

Commands:
  list                 Show the PRs a selection would review (free)
  ceiling              Recall ceiling of the deterministic stages (free, no model)
  run                  Review the selected PRs with ocra, then score them
  score <run-dir>      Re-score an existing run
  adjudicate <run-dir> Record the labels typed into a golden run's adjudication.json in its cases
  compare <baseline-run> <run> [--spread-of <second-baseline-run>]
                       Difference per metric; within the baselines' spread it is "no change"
  trend <runs-dir> [--series <a,b>]
                       Golden runs over time, per series (label without its
                       trailing -<n>): recall, precision and wrap-up turns per
                       run, mean and spread, and each expected finding's hit
                       rate, on the cases common to the runs compared
  golden-import --from aacr
                       Write unverified golden case candidates from AACR-Bench
                       PRs with 1-3 in-scope issues on changed lines, spread
                       across languages (free, no model; --limit default 50,
                       --max-change-lines default 300, --out default
                       .ocra/eval/aacr-golden-candidates)

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
  --retry-failed           Review again PRs that failed, or lost tasks to a spent
                           quota, in an earlier attempt
  --reviewers <ids>        Passed to ocra review --reviewers
  --ultra                  Passed to ocra review --ultra (recall mode; about twice the cost)
  --config <file>          Passed to ocra review --config: your own configuration
                           (declared providers, limits) for reviews that run with
                           --no-repo-config
  --temperature <n>        Passed to ocra review --temperature (default 0)
  --model-seed <n>         Passed to ocra review --seed (default 1; --seed is
                           the selection's)
  --repeat <k>             Review the selection k times (r1/ … rk/ in the run
                           directory) and report each metric's mean and 95%
                           confidence interval
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
    if (command === "trend") return await trend(rest, out, err);
    if (command === "golden-import") return await goldenImport(rest, out, err);
    out.write(USAGE);
    return command === undefined || command === "--help" || command === "-h" ? 0 : 2;
  } catch (error) {
    err.write(`ocra-eval: ${errorMessage(error)}\n`);
    return 2;
  }
}
