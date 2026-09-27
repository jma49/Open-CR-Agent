import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ReportOutput } from "@open-cr-agent/core";
import type { Instance } from "./dataset.js";
import { exec } from "./exec.js";

export interface ReviewOutcome {
  exitCode: number;
  durationMs: number;
  report?: ReportOutput;
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
  options: { command: readonly string[]; timeoutMs: number; reviewArgs?: readonly string[] },
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
      // Benchmark repositories are third-party code: their config must not
      // load plugins on the maintainer's machine.
      "--no-repo-config",
      ...(options.reviewArgs ?? []),
    ],
    { cwd: repoDir, timeoutMs: options.timeoutMs },
  );
  const durationMs = Date.now() - started;

  let report: ReportOutput | undefined;
  try {
    report = JSON.parse(await readFile(outputPath, "utf8")) as ReportOutput;
  } catch {}
  const outcome: ReviewOutcome = { exitCode: result.exitCode, durationMs };
  if (report) outcome.report = report;
  if (result.timedOut) outcome.error = `timed out after ${Math.round(options.timeoutMs / 1000)}s`;
  else if (!report || result.exitCode === 2)
    outcome.error = lastLines(result.stderr) || `exit code ${result.exitCode}`;
  return outcome;
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n");
}
