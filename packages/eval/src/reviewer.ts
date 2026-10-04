import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { errorMessage, type ReportOutput } from "@open-cr-agent/core";
import { readReport } from "@open-cr-agent/core/internal";
import { benchmarkEnv, exec } from "./exec.js";
import type { Instance } from "./instance.js";

export interface ReviewOutcome {
  exitCode: number;
  durationMs: number;
  report?: ReportOutput;
  error?: string;
}

// The built CLI, found through the package's own bin entry: the package
// entry is dist/index.js for users but src/index.ts under the tests' source
// condition, and either way sits one level below the package root.
export function defaultOcraCommand(): string[] {
  const entry = createRequire(import.meta.url).resolve("@open-cr-agent/cli");
  const root = dirname(dirname(entry));
  const { bin } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    bin: { ocra: string };
  };
  return [process.execPath, join(root, bin.ocra)];
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
    { cwd: repoDir, timeoutMs: options.timeoutMs, env: benchmarkEnv() },
  );
  const durationMs = Date.now() - started;

  // A run that failed (exit code 2) writes no report; otherwise a report
  // that cannot be read says why in the outcome.
  let report: ReportOutput | undefined;
  let unreadable: string | undefined;
  try {
    report = await readReport(outputPath);
  } catch (error) {
    unreadable = errorMessage(error);
  }
  const outcome: ReviewOutcome = { exitCode: result.exitCode, durationMs };
  if (report) outcome.report = report;
  if (result.timedOut) outcome.error = `timed out after ${Math.round(options.timeoutMs / 1000)}s`;
  else if (!report || result.exitCode === 2)
    outcome.error = lastLines(result.stderr) || unreadable || `exit code ${result.exitCode}`;
  return outcome;
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-5).join("\n");
}
