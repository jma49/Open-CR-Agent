import { buildTrend, renderTrend } from "../trend.js";
import { loadTrendRuns } from "../trend-load.js";
import { type Output, parse } from "./options.js";

export async function trend(argv: string[], out: Output, err: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [dir] = positionals;
  if (!dir) throw new Error("trend needs a directory of runs");
  const { runs, notes } = await loadTrendRuns(dir);
  for (const note of notes) err.write(`[ocra-eval] skipped ${note}\n`);
  const only = values.series?.split(",").map((s) => s.trim());
  const result = buildTrend(runs, only);
  if (result.series.length === 0) {
    throw new Error(`no golden runs under ${dir}${only ? ` in series ${only.join(", ")}` : ""}`);
  }
  out.write(renderTrend(result));
  return 0;
}
