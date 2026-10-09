import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LABELS_FILE, labelsFor, readLabels } from "../adjudicate.js";
import { scoreAttacks } from "../attack-score.js";
import type { SavedSummary } from "../compare.js";
import { scoreGolden } from "../golden-score.js";
import type { Instance } from "../instance.js";
import { CachedJudge, type JudgeSetup } from "../judges.js";
import { summarizeProvenance } from "../provenance.js";
import { REPEATS_FILE, type Repetition, renderRepeats, summarizeRepeats } from "../repeat.js";
import { type RunInfo, renderMarkdown } from "../report.js";
import type { InstanceResult } from "../results.js";
import { score } from "../score.js";
import { readSessionTrace, type SessionTrace, sessionLogPath } from "../session-trace.js";
import type { Output } from "./options.js";

// The judge's cache is shared by the repetitions of a run.
export async function writeSummary(
  runDir: string,
  info: RunInfo,
  instances: readonly Instance[],
  results: readonly InstanceResult[],
  judge: JudgeSetup,
  cacheDir: string,
): Promise<{ markdown: string; saved: SavedSummary }> {
  const cache = new CachedJudge(judge.judge, join(cacheDir, judge.cacheFile));
  await cache.load();
  const summary: SavedSummary["summary"] = await score(instances, results, cache);
  const goldenDir = info.selection.goldenDir;
  if (typeof goldenDir === "string") {
    summary.golden = await scoreGolden(
      instances,
      results,
      cache,
      await readTraces(runDir, results),
    );
    const attacks = await scoreAttacks(instances, results, cache);
    if (attacks) summary.attacks = attacks;
    const labels = labelsFor(goldenDir, summary.golden.unadjudicated, await readLabels(runDir));
    await writeFile(join(runDir, LABELS_FILE), `${JSON.stringify(labels, null, 2)}\n`);
  }
  const provenance = summarizeProvenance(results);
  if (provenance) summary.provenance = provenance;
  await cache.save();
  const markdown = renderMarkdown(info, summary);
  await writeFile(join(runDir, "summary.json"), `${JSON.stringify({ info, summary }, null, 2)}\n`);
  await writeFile(join(runDir, "summary.md"), markdown);
  return { markdown, saved: { info, summary } };
}

async function readTraces(
  runDir: string,
  results: readonly InstanceResult[],
): Promise<Map<string, SessionTrace>> {
  const traces = new Map<string, SessionTrace>();
  for (const result of results) {
    if (result.status !== "reviewed") continue;
    const trace = await readSessionTrace(sessionLogPath(runDir, result.id));
    if (trace) traces.set(result.id, trace);
  }
  return traces;
}

export async function writeRepeats(
  runDir: string,
  label: string,
  runs: readonly Repetition[],
  out: Output,
): Promise<number> {
  const summary = summarizeRepeats(runs);
  const markdown = renderRepeats(label, summary, runs[0]?.saved);
  await writeFile(join(runDir, REPEATS_FILE), `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(join(runDir, "summary.md"), markdown);
  out.write(`${markdown}\nWritten to ${runDir}\n`);
  return 0;
}
