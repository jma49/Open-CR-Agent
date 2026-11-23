import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { overBudget, perfBudgetSchema, renderPerf } from "../perf/budget.js";
import { measureReview } from "../perf/measure.js";
import { defaultOcraCommand } from "../reviewer.js";
import { number, type Output, parse } from "./options.js";

export async function perf(argv: string[], out: Output): Promise<number> {
  const { values } = parse(argv);
  if (!values.from) throw new Error("perf needs --from <ref>");
  const { runtime } = values;
  if (runtime !== undefined && runtime !== "direct" && runtime !== "opencode") {
    throw new Error("--runtime must be direct or opencode");
  }
  const latencyMs = number(values["latency-ms"], "--latency-ms");
  const budget = values.budget
    ? perfBudgetSchema.parse(JSON.parse(await readFile(values.budget, "utf8")))
    : {};
  const outDir = resolve(values.out ?? ".ocra/eval", values.label ?? "perf");
  const result = await measureReview({
    repoDir: resolve(values["repo-dir"] ?? "."),
    from: values.from,
    to: values.to ?? "HEAD",
    outDir,
    command: defaultOcraCommand(),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(runtime === undefined ? {} : { runtime }),
  });
  await writeFile(join(outDir, "perf.json"), `${JSON.stringify(result, null, 2)}\n`);
  out.write(`${renderPerf(result)}\nWritten to ${outDir}\n`);
  const over = overBudget(result, budget);
  for (const line of over) out.write(`Over budget: ${line}\n`);
  return over.length > 0 ? 1 : 0;
}
