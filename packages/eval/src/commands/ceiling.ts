import { join, resolve } from "node:path";
import { measureCeiling } from "../ceiling-run.js";
import { defaultOcraCommand } from "../reviewer.js";
import { selectInstances } from "../select.js";
import { CACHE_DIR, dataset, loadInstances, type Output, parse, selection } from "./options.js";

export async function ceiling(argv: string[], out: Output, err: Output): Promise<number> {
  const { values } = parse(argv);
  const select = selection(values);
  const name = dataset(values);
  const instances = selectInstances(await loadInstances(name, values), select);
  const outDir = resolve(values.out ?? ".ocra/eval", values.label ?? "ceiling");
  const markdown = await measureCeiling(instances, {
    dataset: name,
    outDir,
    reposDir: values["repos-dir"] ?? join(CACHE_DIR, "repos"),
    command: defaultOcraCommand(),
    log: (message) => err.write(`[ocra-eval] ${message}\n`),
  });
  out.write(`${markdown}\nWritten to ${outDir}\n`);
  return 0;
}
