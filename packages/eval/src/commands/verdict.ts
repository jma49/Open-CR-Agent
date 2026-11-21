import { comparisonWarnings } from "../compare.js";
import { loadRuns } from "../repeat.js";
import { DEFAULT_VERDICT, recallVerdict, renderVerdict } from "../verdict.js";
import { mixedSides } from "./compare.js";
import { type Output, parse } from "./options.js";

// Exit codes: 0 pass, 1 worse, 3 inconclusive (more repeats needed), 2 no
// verdict at all.
export async function verdict(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [baselineDir, runDir] = positionals;
  if (!baselineDir || !runDir) throw new Error("verdict needs a baseline run and a run");
  const margin = values.margin === undefined ? DEFAULT_VERDICT.margin : Number(values.margin);
  if (!Number.isFinite(margin) || margin <= 0 || margin >= 1) {
    throw new Error("--margin must be a share between 0 and 1, such as 0.1 for 10 points");
  }
  const baseline = await loadRuns(baselineDir);
  const run = await loadRuns(runDir);
  const mixed = mixedSides(
    [
      { name: baselineDir, summaries: baseline.summaries },
      { name: runDir, summaries: run.summaries },
    ],
    values["allow-mixed"] === true,
  );
  const result = recallVerdict(baseline.summaries, run.summaries, { ...DEFAULT_VERDICT, margin });
  const warnings = [...mixed, ...comparisonWarnings([...baseline.summaries, ...run.summaries])];
  out.write(renderVerdict(result));
  if (warnings.length > 0) out.write(`\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}\n`);
  if ("refused" in result) return 2;
  return result.verdict === "pass" ? 0 : result.verdict === "worse" ? 1 : 3;
}
