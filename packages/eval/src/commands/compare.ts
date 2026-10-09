import { compareSummaries, comparisonWarnings, renderComparison } from "../compare.js";
import { compareClaims, renderClaimComparison } from "../compare-claims.js";
import { loadRuns } from "../repeat.js";
import { type Output, parse } from "./options.js";

export async function compare(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [baselineDir, runDir] = positionals;
  if (!baselineDir || !runDir) throw new Error("compare needs a baseline run and a run");
  const baseline = await loadRuns(baselineDir);
  const run = await loadRuns(runDir);
  const other = values["spread-of"] ? await loadRuns(values["spread-of"]) : undefined;
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  const warnings = [
    ...(same(baseline.ids, run.ids) ? [] : ["the runs reviewed different PRs"]),
    ...(other && !same(baseline.ids, other.ids) ? ["the baselines reviewed different PRs"] : []),
    ...comparisonWarnings([...baseline.summaries, ...run.summaries, ...(other?.summaries ?? [])]),
  ];
  out.write(
    renderComparison(
      compareSummaries(baseline.summaries, run.summaries, other?.summaries[0]),
      warnings,
    ),
  );
  const claims = compareClaims(baseline.summaries, run.summaries);
  if (claims) out.write(renderClaimComparison(claims));
  return 0;
}
