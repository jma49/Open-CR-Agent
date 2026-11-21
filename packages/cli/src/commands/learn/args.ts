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
  const change = changeOf(values);
  return {
    source: action,
    documents: rest,
    max,
    propose: values.propose === true,
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(change ? { change } : {}),
  };
}

function changeOf(values: {
  pr?: string;
  repo?: string;
  mr?: string;
  project?: string;
}): LearnArgs["change"] {
  if (values.pr !== undefined && values.mr !== undefined) {
    throw new UsageError("--pr and --mr cannot be combined");
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
  if (values.repo !== undefined || values.project !== undefined) {
    throw new UsageError("--repo goes with --pr, --project with --mr");
  }
  return undefined;
}

function positive(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive number`);
  return n;
}
