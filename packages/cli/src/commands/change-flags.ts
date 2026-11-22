import { UsageError } from "../io/usage-error.js";
import type { ReviewArgs } from "./review/args.js";

export interface ChangeFlags {
  pr?: string;
  repo?: string;
  mr?: string;
  project?: string;
}

// The pull or merge request --pr or --mr names; `alone`: --repo and
// --project may also come without one, which `aloneWith` names.
export function changeOf(
  values: ChangeFlags,
  alone: boolean,
  aloneWith?: string,
): Pick<ReviewArgs, "pullRequest" | "mergeRequest"> | undefined {
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
  if (!alone && (values.repo !== undefined || values.project !== undefined)) {
    const or = aloneWith ? ` or ${aloneWith}` : "";
    throw new UsageError(`--repo goes with --pr${or}, --project with --mr${or}`);
  }
  return undefined;
}

function positive(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`${flag} must be a positive number`);
  return n;
}
