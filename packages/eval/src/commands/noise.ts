import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isNotFound } from "@open-cr-agent/core/internal";
import type { SavedSummary } from "../compare.js";
import { comparisonWarnings } from "../compare.js";
import { type NoiseBaseline, noiseBaseline, renderNoise } from "../noise.js";
import { loadRuns } from "../repeat.js";
import { DEFAULT_VERDICT } from "../verdict.js";
import { mixedSides } from "./compare.js";
import { type Output, parse } from "./options.js";

interface RegisteredBaseline {
  label: string;
  registeredAt: string;
  casesHash: string;
  ocraCommit?: string;
  judge?: string;
  runs: number;
  cases: number;
  claims: number;
  recallMean: number;
  recallSd: number;
  requiredMargin: number;
  aaPassed: boolean;
}

// Exit codes: 0 the A/A check passed, 1 it failed, 2 no baseline.
export async function noise(argv: string[], out: Output): Promise<number> {
  const { values, positionals } = parse(argv);
  const [runDir] = positionals;
  if (!runDir) throw new Error("noise needs a run made with --repeat");
  const margin = values.margin === undefined ? DEFAULT_VERDICT.margin : Number(values.margin);
  if (!Number.isFinite(margin) || margin <= 0 || margin >= 1) {
    throw new Error("--margin must be a share between 0 and 1, such as 0.1 for 10 points");
  }
  const { summaries } = await loadRuns(runDir);
  mixedSides([{ name: runDir, summaries }], false);
  const label = basename(resolve(runDir));
  const result = noiseBaseline(summaries, { ...DEFAULT_VERDICT, margin });
  out.write(renderNoise(label, result));
  const warnings = comparisonWarnings(summaries);
  if (warnings.length > 0) out.write(`\nWarnings:\n${warnings.map((w) => `- ${w}`).join("\n")}\n`);
  if ("refused" in result) return 2;
  if (values.register) {
    if (warnings.length > 0) throw new Error("a baseline with warnings is not registered");
    await register(values.register, entry(label, summaries, result));
    out.write(`\nRegistered in ${values.register}\n`);
  }
  return result.passed ? 0 : 1;
}

function entry(label: string, runs: readonly SavedSummary[], b: NoiseBaseline): RegisteredBaseline {
  const first = runs[0];
  const commit = first?.info?.ocra?.commit;
  const judge = first?.info?.judge;
  return {
    label,
    registeredAt: new Date().toISOString(),
    casesHash: first?.summary.golden?.casesHash ?? "",
    ...(commit === undefined ? {} : { ocraCommit: commit }),
    ...(judge === undefined ? {} : { judge }),
    runs: b.runs,
    cases: b.cases,
    claims: b.claims,
    recallMean: b.recall.mean,
    recallSd: b.recall.sd,
    requiredMargin: b.requiredMargin,
    aaPassed: b.passed,
  };
}

// One entry per label: registering a label again replaces it.
async function register(file: string, added: RegisteredBaseline): Promise<void> {
  const existing = await readFile(file, "utf8").then(
    (text) => JSON.parse(text) as RegisteredBaseline[],
    (error: unknown) => {
      if (isNotFound(error)) return [];
      throw error;
    },
  );
  if (!Array.isArray(existing)) throw new Error(`${file} is not a list of baselines`);
  const kept = existing.filter((e) => e.label !== added.label);
  await writeFile(file, `${JSON.stringify([...kept, added], null, 2)}\n`);
}
