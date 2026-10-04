import { parseArgs } from "node:util";
import { OcraError } from "@open-cr-agent/core";
import type { LocalTarget } from "@open-cr-agent/vcs-local";

export type OutputFormat = "text" | "json" | "sarif";

export interface PullRequestTarget {
  number: number;
  repo?: string;
  publish: boolean;
}

export interface MergeRequestTarget {
  iid: number;
  // The project's numeric id or full path.
  project?: string;
  publish: boolean;
}

export interface ReviewArgs {
  target: LocalTarget;
  pullRequest?: PullRequestTarget;
  mergeRequest?: MergeRequestTarget;
  format: OutputFormat;
  output?: string;
  ignoreRepoConfig?: true;
  reviewers?: string[];
  maxCostUsd?: number;
  ultra?: true;
  full?: true;
  plan?: true;
  importSarif?: string[];
  // Read this file instead of the repository's .ocra/config.json.
  configFile?: string;
  // Do not send this review's counts to ocra Cloud.
  noUpload?: true;
  // Override the configuration's sampling.
  temperature?: number;
  seed?: number;
}

export class UsageError extends OcraError {
  constructor(message: string) {
    super("INPUT_USAGE", message);
    this.name = "UsageError";
  }
}

export const REVIEW_USAGE = `Usage: ocra review [options]

Reviews uncommitted changes by default.

Options:
  --from <ref>       Review changes on --to since it diverged from <ref>
  --to <ref>         End of the range (default: HEAD)
  --commit <sha>     Review a single commit
  --pr <number>      Review a GitHub pull request (needs GITHUB_TOKEN)
  --repo <owner/name>  Repository of --pr (default: GITHUB_REPOSITORY or origin)
  --mr <iid>         Review a GitLab merge request (needs GITLAB_TOKEN)
  --project <id|path>  Project of --mr (default: CI_PROJECT_ID or origin)
  --publish          With --pr or --mr: post the review to it
  --full             With --pr or --mr: review every file, not only what
                     changed since the previous review
  --format <format>  text (default), json, or sarif (SARIF 2.1.0; not with --plan)
  --output <file>    Write the result to a file instead of stdout
  --reviewers <ids>  Run only these reviewers (comma-separated)
  --max-cost-usd <n> Spend limit: reviews use 80%, verification and judging the rest
  --import-sarif <file>  Add the results of a SARIF 2.1.0 log (Semgrep, CodeQL, …)
                     that fall on the change; repeatable; not with --plan
  --plan             Show files, bundles, review tasks and prompt sizes; call no model
  --ultra            Favor recall: all reviewers at every tier, two samples each (about 2x cost)
  --temperature <n>  Sampling temperature, 0 to 2 (default: the provider's, or sampling in config)
  --seed <n>         Sampling seed, where the runtime and provider support one
  --config <file>    Read this configuration file instead of the repository's
                     .ocra/config.json; it applies with --no-repo-config too
  --no-repo-config   Ignore .ocra/config.json and its plugins (for untrusted
                     code); models come from OCRA_MODEL_* variables or --config
  --no-upload        When signed in to ocra Cloud, send nothing about this
                     review: no counts, per-reviewer counts or findings
  -h, --help         Show help
`;

export function parseReviewArgs(argv: string[]): ReviewArgs | "help" {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return "help";
  if (positionals.length > 0) throw new UsageError(`Unexpected argument: ${positionals[0]}`);

  const format = values.format ?? "text";
  if (format !== "text" && format !== "json" && format !== "sarif") {
    throw new UsageError(`--format must be text, json or sarif, got ${format}`);
  }

  const args: ReviewArgs = { target: target(values), format };
  const pullRequest = pullRequestTarget(values);
  const mergeRequest = mergeRequestTarget(values);
  if (pullRequest && mergeRequest) throw new UsageError("--pr cannot be combined with --mr");
  if (!pullRequest && !mergeRequest && values.publish) {
    throw new UsageError("--publish requires --pr or --mr");
  }
  if (pullRequest) args.pullRequest = pullRequest;
  if (mergeRequest) args.mergeRequest = mergeRequest;
  if (values.output !== undefined) args.output = values.output;
  if (values["no-repo-config"]) args.ignoreRepoConfig = true;
  if (values["no-upload"]) args.noUpload = true;
  if (values.ultra) args.ultra = true;
  if (values.full) {
    if (!pullRequest && !mergeRequest) throw new UsageError("--full needs --pr or --mr");
    args.full = true;
  }
  if (values.plan) {
    if (values.publish) throw new UsageError("--plan cannot be combined with --publish");
    if (format === "sarif") throw new UsageError("--plan has no findings for --format sarif");
    args.plan = true;
  }
  if (values["max-cost-usd"] !== undefined) {
    const max = Number(values["max-cost-usd"]);
    if (!(max > 0))
      throw new UsageError(
        `--max-cost-usd must be a positive number, got ${values["max-cost-usd"]}`,
      );
    args.maxCostUsd = max;
  }
  if (values.temperature !== undefined) {
    const temperature = Number(values.temperature);
    if (values.temperature.trim() === "" || !(temperature >= 0 && temperature <= 2)) {
      throw new UsageError(`--temperature must be a number from 0 to 2, got ${values.temperature}`);
    }
    args.temperature = temperature;
  }
  if (values.seed !== undefined) {
    const seed = Number(values.seed);
    if (!/^\d+$/.test(values.seed) || seed > 2 ** 31 - 1) {
      throw new UsageError(
        `--seed must be a whole number from 0 to 2147483647, got ${values.seed}`,
      );
    }
    args.seed = seed;
  }
  if (values.config !== undefined) {
    if (values.config === "") throw new UsageError("--config needs a file");
    args.configFile = values.config;
  }
  if (values["import-sarif"] !== undefined && values["import-sarif"].length > 0) {
    if (values.plan) throw new UsageError("--import-sarif is not used by --plan");
    args.importSarif = values["import-sarif"];
  }
  if (values.reviewers !== undefined) {
    const ids = values.reviewers
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (ids.length === 0) throw new UsageError("--reviewers needs at least one reviewer id");
    args.reviewers = ids;
  }
  return args;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      commit: { type: "string" },
      format: { type: "string" },
      output: { type: "string" },
      "no-repo-config": { type: "boolean" },
      "no-upload": { type: "boolean" },
      config: { type: "string" },
      reviewers: { type: "string" },
      "max-cost-usd": { type: "string" },
      "import-sarif": { type: "string", multiple: true },
      ultra: { type: "boolean" },
      temperature: { type: "string" },
      seed: { type: "string" },
      full: { type: "boolean" },
      plan: { type: "boolean" },
      pr: { type: "string" },
      repo: { type: "string" },
      mr: { type: "string" },
      project: { type: "string" },
      publish: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function pullRequestTarget(values: {
  pr?: string;
  repo?: string;
  publish?: boolean;
  from?: string;
  to?: string;
  commit?: string;
}): PullRequestTarget | undefined {
  if (values.pr === undefined) {
    if (values.repo !== undefined) throw new UsageError("--repo requires --pr");
    return undefined;
  }
  if (values.from !== undefined || values.to !== undefined || values.commit !== undefined) {
    throw new UsageError("--pr cannot be combined with --from, --to or --commit");
  }
  const number = Number(values.pr);
  if (!Number.isInteger(number) || number <= 0) {
    throw new UsageError(`--pr must be a pull request number, got ${values.pr}`);
  }
  if (values.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
    throw new UsageError(`--repo must be owner/name, got ${values.repo}`);
  }
  const target: PullRequestTarget = { number, publish: values.publish === true };
  if (values.repo !== undefined) target.repo = values.repo;
  return target;
}

// A GitLab project is a numeric id or a full path, "group/sub/project".
const PROJECT = /^(\d+|[\w.-]+(\/[\w.-]+)+)$/;

function mergeRequestTarget(values: {
  mr?: string;
  project?: string;
  publish?: boolean;
  from?: string;
  to?: string;
  commit?: string;
}): MergeRequestTarget | undefined {
  if (values.mr === undefined) {
    if (values.project !== undefined) throw new UsageError("--project requires --mr");
    return undefined;
  }
  if (values.from !== undefined || values.to !== undefined || values.commit !== undefined) {
    throw new UsageError("--mr cannot be combined with --from, --to or --commit");
  }
  const iid = Number(values.mr);
  if (!Number.isInteger(iid) || iid <= 0) {
    throw new UsageError(`--mr must be a merge request number, got ${values.mr}`);
  }
  if (values.project !== undefined && !PROJECT.test(values.project)) {
    throw new UsageError(`--project must be a project id or group/project, got ${values.project}`);
  }
  const target: MergeRequestTarget = { iid, publish: values.publish === true };
  if (values.project !== undefined) target.project = values.project;
  return target;
}

function target(values: { from?: string; to?: string; commit?: string }): LocalTarget {
  if (values.commit !== undefined) {
    if (values.from !== undefined || values.to !== undefined) {
      throw new UsageError("--commit cannot be combined with --from or --to");
    }
    return { mode: "commit", commit: values.commit };
  }
  if (values.from !== undefined)
    return { mode: "range", from: values.from, to: values.to ?? "HEAD" };
  if (values.to !== undefined) throw new UsageError("--to requires --from");
  return { mode: "workspace" };
}
