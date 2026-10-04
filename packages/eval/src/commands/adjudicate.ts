import { join } from "node:path";
import { applyLabels, LABELS_FILE, readLabels } from "../adjudicate.js";
import { type Output, parse } from "./options.js";

export async function adjudicate(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const runDir = positionals[0];
  if (!runDir) throw new Error("adjudicate needs a run directory");
  const labels = await readLabels(runDir);
  if (!labels)
    throw new Error(`${join(runDir, LABELS_FILE)} does not exist; is this a golden run?`);
  const result = await applyLabels(labels, values["golden-dir"] ?? labels.goldenDir);
  out.write(
    `${result.applied} label(s) recorded, ${result.alreadyRecorded} already recorded, ${result.pending} still unlabeled\n`,
  );
  return 0;
}
