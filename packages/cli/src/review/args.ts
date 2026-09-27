import { parseArgs } from "node:util";
import type { LocalTarget } from "@open-cr-agent/vcs-local";

export type OutputFormat = "text" | "json";

export interface PullRequestTarget {
  number: number;
  repo?: string;
  publish: boolean;
}

export interface ReviewArgs {
  target: LocalTarget;
  pullRequest?: PullRequestTarget;
  format: OutputFormat;
  output?: string;
  ignoreRepoConfig?: true;
  reviewers?: string[];
  maxCostUsd?: number;
  ultra?: true;
  full?: true;
  plan?: true;
}

export class UsageError extends Error {}

export const REVIEW_USAGE = `Usage: ocra review [options]

Reviews uncommitted changes by default.

Options:
  --from <ref>       Review changes on --to since it diverged from <ref>
  --to <ref>         End of the range (default: HEAD)
  --commit <sha>     Review a single commit
  --pr <number>      Review a GitHub pull request (needs GITHUB_TOKEN)
  --repo <owner/name>  Repository of --pr (default: GITHUB_REPOSITORY or origin)
  --publish          With --pr: post the review to the pull request
  --full             With --pr: review every file, not only what changed since
                     the previous review
  --format <format>  text (default) or json
  --output <file>    Write the result to a file instead of stdout
  --reviewers <ids>  Run only these reviewers (comma-separated)
  --max-cost-usd <n> Spend limit: reviews use 80%, verification and judging the rest
  --plan             Show files, bundles, review tasks and prompt sizes; call no model
  --ultra            Favor recall: all reviewers at every tier, two samples each (about 2x cost)
  --no-repo-config   Ignore .ocra/config.json and its plugins (for untrusted
                     code); models come from OCRA_MODEL_* variables
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
  if (format !== "text" && format !== "json") {
    throw new UsageError(`--format must be text or json, got ${format}`);
  }

  const args: ReviewArgs = { target: target(values), format };
  const pullRequest = pullRequestTarget(values);
  if (pullRequest) args.pullRequest = pullRequest;
  if (values.output !== undefined) args.output = values.output;
  if (values["no-repo-config"]) args.ignoreRepoConfig = true;
  if (values.ultra) args.ultra = true;
  if (values.full) {
    if (!pullRequest) throw new UsageError("--full needs --pr");
    args.full = true;
  }
  if (values.plan) {
    if (values.publish) throw new UsageError("--plan cannot be combined with --publish");
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
      reviewers: { type: "string" },
      "max-cost-usd": { type: "string" },
      ultra: { type: "boolean" },
      full: { type: "boolean" },
      plan: { type: "boolean" },
      pr: { type: "string" },
      repo: { type: "string" },
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
    if (values.publish) throw new UsageError("--publish requires --pr");
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
