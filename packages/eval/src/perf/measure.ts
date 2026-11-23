import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@open-cr-agent/core";
import { readReport } from "@open-cr-agent/core/internal";
import { benchmarkEnv, exec } from "../exec.js";
import { type ModelCalls, scriptedModel } from "./scripted-model.js";

export interface PerfOptions {
  repoDir: string;
  from: string;
  to: string;
  outDir: string;
  command: readonly string[];
  // What each model request waits before it is answered.
  latencyMs?: number;
  runtime?: "direct" | "opencode";
  timeoutMs?: number;
}

export interface PerfResult {
  runtime: string;
  latencyMs: number;
  review: { exitCode: number; files: number; tasks: number; findings: number };
  wallMs: number;
  // When Verify answered for the first file: the earliest a checked finding
  // can be shown (ADR-0074). Absent when the review verified nothing.
  firstVerifiedMs?: number;
  // The ocra process alone, not the git and runtime processes it starts.
  cpuMs: number;
  peakMemoryMb: number;
  git: { processes: number; byCommand: Record<string, number> };
  model: ModelCalls & { byKind: Record<string, ModelCalls> };
}

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

// Loaded into the ocra process, which writes what it used as it exits.
const USAGE_PROBE = `import { writeFileSync } from "node:fs";
process.on("exit", () => writeFileSync(process.env.OCRA_PERF_USAGE, JSON.stringify(process.resourceUsage())));
`;

/**
 * One review of a local range with the real CLI and the scripted model:
 * what ocra itself costs around the model calls, and what it sends them.
 */
export async function measureReview(options: PerfOptions): Promise<PerfResult> {
  const { outDir, latencyMs = 0, runtime = "direct" } = options;
  await mkdir(outDir, { recursive: true });
  const paths = {
    probe: join(outDir, "usage-probe.mjs"),
    usage: join(outDir, "usage.json"),
    trace: join(outDir, "git-trace.log"),
    config: join(outDir, "config.json"),
    report: join(outDir, "report.json"),
  };
  const model = await scriptedModel(latencyMs);
  try {
    await Promise.all([
      writeFile(paths.probe, USAGE_PROBE),
      writeFile(paths.trace, ""),
      writeFile(paths.config, JSON.stringify(configFor(model.url, runtime))),
    ]);
    const [node = process.execPath, ...cli] = options.command;
    const started = Date.now();
    const run = await exec(
      node,
      [
        "--import",
        pathToFileURL(paths.probe).href,
        ...cli,
        "review",
        "--from",
        options.from,
        "--to",
        options.to,
        "--config",
        paths.config,
        "--no-repo-config",
        "--format",
        "json",
        "--output",
        paths.report,
      ],
      {
        cwd: options.repoDir,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...benchmarkEnv(), GIT_TRACE: paths.trace, OCRA_PERF_USAGE: paths.usage },
      },
    );
    const wallMs = Date.now() - started;
    const report = await readReport(paths.report).catch((error) => {
      throw new Error(
        `the review wrote no report (exit ${run.exitCode}): ${errorMessage(error)}\n${run.stderr.slice(-2_000)}`,
      );
    });
    const usage = JSON.parse(await readFile(paths.usage, "utf8")) as NodeJS.ResourceUsage;
    const byKind = model.calls();
    const firstVerifiedAt = model.firstVerifiedAt();
    return {
      runtime,
      latencyMs,
      review: {
        exitCode: run.exitCode,
        files: report.coverage.length,
        tasks: report.tasks.length,
        findings: report.findings.length,
      },
      wallMs,
      ...(firstVerifiedAt === undefined ? {} : { firstVerifiedMs: firstVerifiedAt - started }),
      cpuMs: Math.round((usage.userCPUTime + usage.systemCPUTime) / 1000),
      // Kilobytes on every platform Node reports it for.
      peakMemoryMb: Math.round(usage.maxRSS / 1024),
      git: gitProcesses(await readFile(paths.trace, "utf8")),
      model: { ...total(Object.values(byKind)), byKind },
    };
  } finally {
    await model.close();
  }
}

function configFor(url: string, runtime: string) {
  const price = { input: 1, output: 1 };
  return {
    runtime,
    models: { top: ["scripted/top"], standard: ["scripted/standard"], light: ["scripted/light"] },
    providers: {
      scripted: {
        type: "openai-compatible",
        baseUrl: url,
        models: { top: price, standard: price, light: price },
      },
    },
  };
}

export function gitProcesses(trace: string): PerfResult["git"] {
  const byCommand: Record<string, number> = {};
  for (const [, command = ""] of trace.matchAll(/trace: built-in: git (\S+)/g)) {
    byCommand[command] = (byCommand[command] ?? 0) + 1;
  }
  const processes = Object.values(byCommand).reduce((sum, n) => sum + n, 0);
  return { processes, byCommand };
}

function total(calls: readonly ModelCalls[]): ModelCalls {
  return {
    requests: sum(calls, (c) => c.requests),
    inputTokens: sum(calls, (c) => c.inputTokens),
    repeatedTokens: sum(calls, (c) => c.repeatedTokens),
    largestRequestTokens: Math.max(0, ...calls.map((c) => c.largestRequestTokens)),
  };
}

function sum(calls: readonly ModelCalls[], pick: (c: ModelCalls) => number): number {
  return calls.reduce((n, c) => n + pick(c), 0);
}
