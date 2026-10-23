import { compareSummaries, comparisonWarnings, renderComparison } from "../compare.js";
import { compareClaims, renderClaimComparison } from "../compare-claims.js";
import { mixedSetups } from "../provenance.js";
import { loadRuns } from "../repeat.js";
import { type Output, parse } from "./options.js";

export async function compare(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [baselineDir, runDir] = positionals;
  if (!baselineDir || !runDir) throw new Error("compare needs a baseline run and a run");
  const baseline = await loadRuns(baselineDir);
  const run = await loadRuns(runDir);
  const spreadDir = values["spread-of"];
  const other = spreadDir ? await loadRuns(spreadDir) : undefined;
  const same = (a: string[], b: string[]) =>
    a.length === b.length && a.every((id, i) => id === b[i]);
  // Each side is one setup: a run, its repetitions, and the second baseline
  // with the first.
  const sides = [
    {
      name: spreadDir ? `${baselineDir} with ${spreadDir}` : baselineDir,
      summaries: [...baseline.summaries, ...(other?.summaries ?? [])],
    },
    { name: runDir, summaries: run.summaries },
  ];
  const mixed = sides.flatMap(({ name, summaries }) =>
    mixedSetups(summaries.map((s) => s.summary.provenance)).map((m) => `${name}: ${m}`),
  );
  if (mixed.length > 0 && values["allow-mixed"] !== true) {
    throw new Error(
      `a side of the comparison is not one setup, so its numbers measure none:\n${mixed.map((m) => `- ${m}`).join("\n")}\nReview those PRs again on one setup (a new --label), or pass --allow-mixed to compare anyway`,
    );
  }
  const warnings = [
    ...(same(baseline.ids, run.ids) ? [] : ["the runs reviewed different PRs"]),
    ...(other && !same(baseline.ids, other.ids) ? ["the baselines reviewed different PRs"] : []),
    ...mixed,
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
