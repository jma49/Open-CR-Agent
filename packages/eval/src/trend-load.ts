import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { errorMessage } from "@open-cr-agent/core";
import { isNotFound } from "@open-cr-agent/core/internal";
import { z } from "zod";
import type { TrendRun, WrapUps } from "./trend.js";

// A tree of runs as the cache or downloaded artifacts lay it out: any
// directory with run.json is a run (a repeated run's r1/ … rk/ included).
// Bounded, and symlinks are not followed.
const MAX_DEPTH = 4;
const NOT_RUNS = new Set(["instances", "reports"]);

// What trend reads of a saved summary. Loose on purpose: summaries from
// older ocra-eval versions lack later fields, and trend says what is missing.
const caseScoreSchema = z.object({
  expected: z.int().nonnegative(),
  found: z.int().nonnegative(),
  reported: z.int().nonnegative(),
  right: z.int().nonnegative(),
  claims: z.array(z.object({ concern: z.string(), found: z.boolean() })),
});
const summarySchema = z.object({
  info: z.object({
    runId: z.string(),
    createdAt: z.string().optional(),
    judge: z.string().optional(),
    ocra: z.object({ commit: z.string().optional() }).optional(),
  }),
  summary: z.object({
    golden: z
      .object({
        recall: z.number(),
        precision: z.number(),
        casesHash: z.string(),
        cases: z.record(z.string(), caseScoreSchema).optional(),
      })
      .optional(),
  }),
});
// The wrap-up turn is newer than some reports; a report without it had none.
const reportSchema = z.object({
  tasks: z.array(z.object({ wrapUp: z.object({ findings: z.int().nonnegative() }).optional() })),
});

export async function loadTrendRuns(root: string): Promise<{ runs: TrendRun[]; notes: string[] }> {
  const runs: TrendRun[] = [];
  const notes: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === "run.json")) {
      const name = relative(root, dir) || ".";
      try {
        const run = await loadRun(dir);
        if (typeof run === "string") notes.push(`${name}: ${run}`);
        else runs.push(run);
      } catch (error) {
        notes.push(`${name}: ${errorMessage(error)}`);
      }
      return;
    }
    if (depth >= MAX_DEPTH) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !NOT_RUNS.has(entry.name)) {
        await visit(join(dir, entry.name), depth + 1);
      }
    }
  };
  await visit(root, 0);
  return { runs, notes };
}

// A run, or why it is not one trend can use.
async function loadRun(dir: string): Promise<TrendRun | string> {
  let text: string;
  try {
    text = await readFile(join(dir, "summary.json"), "utf8");
  } catch (error) {
    if (isNotFound(error)) return "not scored yet (no summary.json)";
    throw error;
  }
  const { info, summary } = summarySchema.parse(JSON.parse(text));
  if (!summary.golden) return "not a golden run";
  const cases = summary.golden.cases;
  const wrapUps: Record<string, WrapUps> = {};
  for (const id of Object.keys(cases ?? {})) {
    // Case ids become paths: the same rule as run.json's (score.ts).
    if (!/^[\w.@-]+$/.test(id) || id.startsWith(".")) throw new Error(`invalid case id "${id}"`);
    const wrapUp = await readWrapUps(join(dir, "reports", `${id}.json`));
    if (wrapUp) wrapUps[id] = wrapUp;
  }
  return {
    runId: info.runId,
    dir,
    createdAt: info.createdAt,
    commit: info.ocra?.commit,
    judge: info.judge,
    casesHash: summary.golden.casesHash,
    overall: { recall: summary.golden.recall, precision: summary.golden.precision },
    cases,
    wrapUps,
  };
}

async function readWrapUps(path: string): Promise<WrapUps | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
  const parsed = reportSchema.safeParse(JSON.parse(text));
  if (!parsed.success) return undefined;
  const turns = parsed.data.tasks.flatMap((t) => (t.wrapUp ? [t.wrapUp.findings] : []));
  return { turns: turns.length, findings: turns.reduce((s, n) => s + n, 0) };
}
