import { parseArgs } from "node:util";
import { UsageError } from "../../io/usage-error.js";
import type { ReviewArgs } from "../review/args.js";

export const DEFAULT_MAX = 20;

export interface LearnArgs {
  source: string;
  documents: string[];
  max: number;
  propose: boolean;
  maxCostUsd?: number;
  // The pull or merge request `ocra learn remember` reads.
  change?: Pick<ReviewArgs, "pullRequest" | "mergeRequest">;
  // Where --propose opens its change request, when a flag names it.
  proposeOn?: ProposalPlace;
}

export interface ProposalPlace {
  platform: "github" | "gitlab";
  repository?: string;
}

export function parseLearnArgs(argv: string[], sources: readonly string[]): LearnArgs | "help" {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      max: { type: "string" },
      "max-cost-usd": { type: "string" },
      propose: { type: "boolean" },
      pr: { type: "string" },
      repo: { type: "string" },
      mr: { type: "string" },
      project: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  const [action, ...rest] = positionals;
  if (
    action === undefined ||
    !sources.includes(action) ||
    (action !== "import" && rest.length > 0)
  ) {
    throw new UsageError(
      action === undefined ? "" : `Unknown learn command: ${positionals.join(" ")}`,
    );
  }
  const max = values.max === undefined ? DEFAULT_MAX : Number(values.max);
  if (!Number.isInteger(max) || max < 1) {
    throw new UsageError(`--max must be a positive whole number, got ${values.max}`);
  }
  const cost = values["max-cost-usd"];
  const maxCostUsd = cost === undefined ? undefined : Number(cost);
  if (maxCostUsd !== undefined && !(maxCostUsd > 0)) {
    throw new UsageError(`--max-cost-usd must be a positive number, got ${cost}`);
  }
  const change = changeOf(values, values.propose === true);
  const proposeOn = placeOf(values);
  return {
    source: action,
    documents: rest,
    max,
    propose: values.propose === true,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(change ? { change } : {}),
    ...(values.propose && proposeOn ? { proposeOn } : {}),
  };
}

interface ChangeFlags {
  pr?: string;
  repo?: string;
  mr?: string;
  project?: string;
}

function changeOf(values: ChangeFlags, propose: boolean): LearnArgs["change"] {
  const github = values.pr !== undefined || values.repo !== undefined;
  if (github && (values.mr !== undefined || values.project !== undefined)) {
    throw new UsageError(
      "GitHub's --pr and --repo cannot be combined with GitLab's --mr and --project",
    );
  }
  if (values.pr !== undefined) {
    return {
      pullRequest: {
        number: positive("--pr", values.pr),
        ...(values.repo ? { repo: values.repo } : {}),
        publish: false,
      },
    };
  }
  if (values.mr !== undefined) {
    return {
      mergeRequest: {
        iid: positive("--mr", values.mr),
        ...(values.project ? { project: values.project } : {}),
        publish: false,
      },
    };
  }
  if (!propose && (values.repo !== undefined || values.project !== undefined)) {
    throw new UsageError("--repo goes with --pr or --propose, --project with --mr or --propose");
  }
  return undefined;
}

function placeOf(values: ChangeFlags): ProposalPlace | undefined {
  if (values.pr !== undefined || values.repo !== undefined) {
    return { platform: "github", ...(values.repo ? { repository: values.repo } : {}) };
  }
  if (values.mr !== undefined || values.project !== undefined) {
    return { platform: "gitlab", ...(values.project ? { repository: values.project } : {}) };
  }
  return undefined;
}

function positive(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive number`);
  return n;
}
