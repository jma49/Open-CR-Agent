import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ReviewReport } from "@open-cr-agent/core";
import type { Instance } from "./dataset.js";
import { exec } from "./exec.js";

export interface ReviewOutcome {
  exitCode: number;
  durationMs: number;
  report?: ReviewReport;
  error?: string;
}

export function defaultOcraCommand(): string[] {
  const entry = createRequire(import.meta.url).resolve("@open-cr-agent/cli");
  return [process.execPath, join(dirname(entry), "main.js")];
}

// Runs the real CLI as a black box, like the official adapters for other
// reviewers, so the benchmark measures what users run.
export async function reviewInstance(
  repoDir: string,
  instance: Instance,
  outputPath: string,
  options: { command: readonly string[]; timeoutMs: number },
): Promise<ReviewOutcome> {
  const [bin, ...prefix] = options.command;
  if (!bin) throw new Error("ocra command is empty");
  await rm(outputPath, { force: true });
  const started = Date.now();
  const result = await exec(
    bin,
    [
      ...prefix,
      "review",
      "--from",
      instance.baseCommit,
      "--to",
      instance.headCommit,
      "--format",
      "json",
      "--output",
      outputPath,
    ],
    { cwd: repoDir, timeoutMs: options.timeoutMs },
  );
  const durationMs = Date.now() - started;

  let report: ReviewReport | undefined;
  try {
    report = JSON.parse(await readFile(outputPath, "utf8")) as ReviewReport;
  } catch {}
  const outcome: ReviewOutcome = { exitCode: result.exitCode, durationMs };
  if (report) outcome.report = report;
  if (!report || result.exitCode === 2)
    outcome.error = lastLines(result.stderr) || `exit code ${result.exitCode}`;
  return outcome;
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n");
}
