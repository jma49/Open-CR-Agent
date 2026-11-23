import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type FixResult,
  fixResultSchema,
  sharedFindingSchema,
} from "@open-cr-agent/cloud-contract";
import { treeSitterSyntax } from "@open-cr-agent/code-graph";
import { addUsage, emptyUsage, errorMessage, OcraError, type Usage } from "@open-cr-agent/core";
import { type FixedFinding, fixFinding, type StoredFinding } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { changeOf } from "./change-flags.js";
import { parseLocalTarget, type ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

export const FIX_USAGE = `Usage: ocra fix (--pr <n> | --mr <n> | --from <ref> [--to <ref>] | --commit <sha>)
                --finding <file|-> [options]

Writes a checked fix for one finding a review reported, as ocra review
--fixes would: the finding is found again at the change's head, and only a
finding anchored to at most 30 lines the change added or kept, not low
confidence, gets one fixer model call. The fix is checked (the lines are
unchanged, it parses no worse, it is small and committable) and printed;
nothing is committed or pushed.

Options:
  --finding <file|->  The finding as JSON, as ocra Cloud stores it
                      (sharedFindingSchema); - reads it from stdin
  --head <sha>        The head the finding was reviewed at: if the change's
                      head is another, write nothing and exit 3
  --pr <n>            The GitHub pull request (needs GITHUB_TOKEN)
  --repo <owner/name> Its repository (default: GITHUB_REPOSITORY or origin)
  --mr <n>            The GitLab merge request (needs GITLAB_TOKEN)
  --project <id|path> Its project (default: CI_PROJECT_ID or origin)
  --from <ref>        A local range: the changes on --to since <ref>
  --to <ref>          End of the range (default: HEAD)
  --commit <sha>      A local commit against its parent
  --config <file>     Read this configuration file instead of the
                      repository's .ocra/config.json
  --max-cost-usd <n>  Spend limit (default: maxCostUsd in config)
  --json              Print one line of JSON with the outcome on stdout
  -h, --help          Show help

Exit codes: 0 a fix, or none for a reason the output gives; 3 the finding's
code is gone (stale) or the head moved; 2 usage, input or model errors.
`;

// A stored finding is a few fields of at most a few kilobytes each.
const MAX_FINDING_BYTES = 256 * 1024;
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export async function fixCommand(argv: string[], io: ReviewIo, deps: ReviewDeps): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      finding: { type: "string" },
      head: { type: "string" },
      pr: { type: "string" },
      repo: { type: "string" },
      mr: { type: "string" },
      project: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      commit: { type: "string" },
      config: { type: "string" },
      "max-cost-usd": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.out.write(FIX_USAGE);
    return EXIT.ok;
  }
  const change = changeOf(values, false);
  const target = parseLocalTarget(values);
  if (change && target.mode !== "workspace") {
    throw new UsageError("--pr and --mr cannot be combined with --from, --to or --commit");
  }
  if (!change && target.mode === "workspace") {
    throw new UsageError("ocra fix needs --pr, --mr, --from or --commit");
  }
  if (!values.finding) throw new UsageError("ocra fix needs --finding <file|->");
  if (values.head !== undefined && !COMMIT_ID.test(values.head)) {
    throw new UsageError("--head must be a full commit id (40 or 64 lowercase hex characters)");
  }
  if (values.config === "") throw new UsageError("--config needs a file");
  const maxCostUsd = costOf(values["max-cost-usd"]);
  const finding = await readFinding(values.finding, deps);

  const reviewArgs: ReviewArgs = {
    target,
    format: "text",
    ...change,
    ...(values.config !== undefined ? { configFile: values.config } : {}),
  };
  const run = await resolveRun(reviewArgs, io, deps, { logged: false });
  const { runtime, stopCloud } = await startRuntime(run, deps, {});
  const stopListening = deps.onInterrupt?.(() => run.interrupt.abort());
  let usage: Usage = emptyUsage();
  try {
    const limit = maxCostUsd ?? run.config.maxCostUsd;
    const fixed = await fixFinding({
      finding,
      vcs: run.vcs,
      runtime,
      syntax: treeSitterSyntax(),
      effort: run.config.effort,
      roles: run.config.roles,
      ...(values.head !== undefined ? { expectedHead: values.head } : {}),
      ...(limit !== undefined ? { maxCostUsd: limit } : {}),
      signal: run.interrupt.signal,
      onUsage: (spent) => (usage = addUsage(usage, spent)),
    });
    if (run.interrupt.signal.aborted) return EXIT.interrupted;
    for (const warning of fixed.warnings) run.warn(warning);
    const result = fixResultSchema.parse(resultOf(finding.fingerprint, fixed, usage));
    if (values.json) io.out.write(`${JSON.stringify(result)}\n`);
    else if (result.fix) io.out.write(`${result.fix.replacement}\n`);
    io.err.write(`[ocra] ${said(finding.file, result)}; $${usage.costUsd.toFixed(4)}\n`);
    return result.outcome === "stale" || result.outcome === "head_moved"
      ? EXIT.findingGone
      : EXIT.ok;
  } finally {
    stopListening?.();
    stopCloud();
    await runtime.dispose?.();
  }
}

function costOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const max = Number(value);
  if (!(max > 0)) throw new UsageError(`--max-cost-usd must be a positive number, got ${value}`);
  return max;
}

async function readFinding(source: string, deps: ReviewDeps): Promise<StoredFinding> {
  let text: string;
  if (source === "-") {
    text = await (deps.readStdin ?? readStdin)(MAX_FINDING_BYTES);
  } else {
    const path = resolve(deps.cwd, source);
    if ((await stat(path)).size > MAX_FINDING_BYTES) throw tooLarge();
    text = await readFile(path, "utf8");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new OcraError("INPUT_INVALID", `--finding is not JSON: ${errorMessage(error)}`);
  }
  const parsed = sharedFindingSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))];
    throw new OcraError("INPUT_INVALID", `--finding is not a finding: ${fields.join(", ")}`);
  }
  return storedFinding(parsed.data);
}

async function readStdin(max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > max) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function tooLarge(): OcraError {
  return new OcraError("INPUT_INVALID", `--finding is over ${MAX_FINDING_BYTES} bytes`);
}

function storedFinding(f: ReturnType<typeof sharedFindingSchema.parse>): StoredFinding {
  return {
    fingerprint: f.fingerprint,
    reviewer: f.reviewer,
    severity: f.severity,
    category: f.category ?? "",
    file: f.file,
    title: f.title,
    body: f.body,
    ...(f.suggestion ? { suggestion: f.suggestion } : {}),
    ...(f.code ? { existingCode: f.code } : {}),
    ...(f.lowConfidence ? { lowConfidence: true } : {}),
    ...(f.redacted || f.truncated ? { altered: true } : {}),
  };
}

function resultOf(fingerprint: string, fixed: FixedFinding, usage: Usage): FixResult {
  return {
    fingerprint,
    headSha: fixed.headSha,
    outcome: fixed.outcome,
    fix: fixed.fix ?? null,
    reason: fixed.reason ?? null,
    usage,
  };
}

function said(file: string, result: FixResult): string {
  const where = forTerminal(file);
  if (result.fix) return `Fix for ${where}:${result.fix.startLine}-${result.fix.endLine}`;
  if (result.outcome === "head_moved") return "No fix: the head is not --head";
  return `No fix for ${where}: ${result.outcome} (${result.reason})`;
}
