import { join, resolve } from "node:path";
import { measureContext } from "../context-run.js";
import { defaultOcraCommand } from "../reviewer.js";
import { selectInstances } from "../select.js";
import {
  CACHE_DIR,
  dataset,
  loadInstances,
  type Output,
  parse,
  selection,
  without,
} from "./options.js";

export async function context(argv: string[], out: Output, err: Output): Promise<number> {
  const { values } = parse(argv);
  const instances = selectInstances(
    await loadInstances(dataset(values), values),
    selection(values),
  );
  const outDir = resolve(values.out ?? ".ocra/eval", values.label ?? "context");
  const markdown = await measureContext(instances, {
    outDir,
    reposDir: values["repos-dir"] ?? join(CACHE_DIR, "repos"),
    command: defaultOcraCommand(),
    without: without(values),
    log: (message) => err.write(`[ocra-eval] ${message}\n`),
  });
  out.write(`${markdown}\nWritten to ${outDir}\n`);
  return 0;
}
