import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { z } from "zod";
import type { SavedSummary } from "../compare.js";
import type { Instance } from "../instance.js";
import { createJudge, type JudgeSetup } from "../judges.js";
import { type Repetition, readRepeats, repetitionDir } from "../repeat.js";
import { runInfoSchema } from "../report.js";
import { type InstanceResult, readResult } from "../results.js";
import { loadInstances, type Output, parse } from "./options.js";
import { writeRepeats, writeSummary } from "./summary.js";

export async function rescore(
  argv: string[],
  out: Output,
  _err: Output,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const { values, positionals } = parse(argv);
  const runDir = positionals[0];
  if (!runDir) throw new Error("score needs a run directory");
  const judge = createJudge(values["mock-judge"] === true, env);
  const repeats = await readRepeats(runDir);
  if (!repeats) {
    const { markdown } = await rescoreOne(runDir, runDir, values["golden-dir"], judge);
    out.write(`${markdown}\nWritten to ${runDir}\n`);
    return 0;
  }
  const runs: Repetition[] = [];
  for (const [n] of repeats.runs.entries()) {
    const dir = repetitionDir(runDir, n + 1);
    runs.push({
      name: `r${n + 1}`,
      saved: (await rescoreOne(dir, runDir, values["golden-dir"], judge)).saved,
    });
  }
  return writeRepeats(runDir, basename(resolve(runDir)), runs, out);
}

// run.json: what a run was asked for, and the PRs it took, in order.
const savedRunSchema = z.strictObject({ info: runInfoSchema, ids: z.array(z.string()) });

async function rescoreOne(
  runDir: string,
  cacheDir: string,
  goldenDirFlag: string | undefined,
  judge: JudgeSetup,
): Promise<{ markdown: string; saved: SavedSummary }> {
  const saved = savedRunSchema.parse(JSON.parse(await readFile(join(runDir, "run.json"), "utf8")));
  // run.json is a file on disk like any other: its ids become paths below.
  const bad = saved.ids.find((id) => !/^[\w.@-]+$/.test(id) || id.startsWith("."));
  if (bad !== undefined) throw new Error(`run.json lists an invalid id "${bad}"`);
  const savedDir = saved.info.selection.goldenDir;
  const goldenDir = goldenDirFlag
    ? resolve(goldenDirFlag)
    : typeof savedDir === "string"
      ? savedDir
      : undefined;
  const all = await loadInstances(saved.info.selection.dataset === "golden" ? "golden" : "aacr", {
    "golden-dir": goldenDir,
  });
  const instances = saved.ids
    .map((id) => all.find((i) => i.id === id))
    .filter((i): i is Instance => !!i);
  const results: InstanceResult[] = [];
  for (const id of saved.ids) {
    // A PR the run never reached has no result.
    const result = await readResult(join(runDir, "instances", `${id}.json`));
    if (result) results.push(result);
  }
  return writeSummary(
    runDir,
    {
      ...saved.info,
      // adjudicate writes labels where the cases were read from.
      selection: { ...saved.info.selection, ...(goldenDir ? { goldenDir } : {}) },
      judge: judge.description,
    },
    instances,
    results,
    judge,
    cacheDir,
  );
}
