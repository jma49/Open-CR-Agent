import { parseArgs } from "node:util";
import {
  GENERATE_KINDS,
  type GenerateKind,
  type GenerateResult,
  generateResultSchema,
} from "@open-cr-agent/cloud-contract";
import {
  addUsage,
  type CommitResult,
  emptyUsage,
  OcraError,
  type Usage,
} from "@open-cr-agent/core";
import { type Generated, generateChanges } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { changeOf } from "./change-flags.js";
import { renderPatch } from "./generate/patch.js";
import type { ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

export const GENERATE_USAGE = `Usage: ocra generate <tests|docstrings> (--pr <n> | --mr <n>) [options]

Writes one commit on the pull or merge request's branch, one writer model
call per changed source file (at most 5):
  tests       a new test file beside each, by the repository's naming;
              ocra never runs them, nor changes an existing file
  docstrings  doc comments for the declarations the change adds or alters;
              ocra only inserts comment lines in the changed lines

It commits only on top of the head it read: when the branch moved, or the
token cannot write to it (a fork's branch), it commits nothing, says why
on stderr and exits 3.

Options:
  --pr <n>            The GitHub pull request (needs GITHUB_TOKEN)
  --repo <owner/name> Its repository (default: GITHUB_REPOSITORY or origin)
  --mr <n>            The GitLab merge request (needs GITLAB_TOKEN)
  --project <id|path> Its project (default: CI_PROJECT_ID or origin)
  --config <file>     Read this configuration file instead of the base's
                      .ocra/config.json
  --dry-run           Print the edits as a unified diff; commit nothing
  --json              Print one line of JSON with the outcome on stdout
  -h, --help          Show help
`;

export async function generateCommand(
  argv: string[],
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      mr: { type: "string" },
      project: { type: "string" },
      config: { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.out.write(GENERATE_USAGE);
    return EXIT.ok;
  }
  const [kind, ...extra] = positionals;
  if (!isKind(kind) || extra.length > 0) {
    throw new UsageError("ocra generate needs tests or docstrings");
  }
  const change = changeOf(values, false);
  if (!change) throw new UsageError("ocra generate needs --pr or --mr");
  if (values.config === "") throw new UsageError("--config needs a file");

  const reviewArgs: ReviewArgs = {
    target: { mode: "workspace" },
    format: "text",
    ...change,
    ...(values.config !== undefined ? { configFile: values.config } : {}),
  };
  const run = await resolveRun(reviewArgs, io, deps, { logged: false });
  const commit = run.vcs.commit?.bind(run.vcs);
  if (!commit) throw new OcraError("CONFIG_INVALID", "this platform cannot take a commit");
  const { runtime, stopCloud } = await startRuntime(run, deps, {});
  const stopListening = deps.onInterrupt?.(() => run.interrupt.abort());
  let usage: Usage = emptyUsage();
  try {
    const generated = await generateChanges({
      kind,
      vcs: run.vcs,
      runtime,
      selection: { include: run.config.include, exclude: run.config.exclude },
      effort: run.config.effort,
      roles: run.config.roles,
      signal: run.interrupt.signal,
      onUsage: (spent) => (usage = addUsage(usage, spent)),
    });
    for (const s of generated.skipped) {
      io.err.write(`[ocra] Skipped ${forTerminal(s.path)}: ${forTerminal(s.reason)}\n`);
    }
    const ended = await end(generated, values["dry-run"] === true, commit);
    const result = generateResultSchema.parse({
      kind,
      headSha: generated.headSha,
      files: generated.edits.map((e) => e.path),
      usage,
      ...ended,
    } satisfies GenerateResult);
    if (values.json) io.out.write(`${JSON.stringify(result)}\n`);
    else if (result.outcome === "dry_run") io.out.write(renderPatch(generated.edits));
    io.err.write(`[ocra] ${said(result)}; $${usage.costUsd.toFixed(4)}\n`);
    return result.outcome === "head_moved" || result.outcome === "not_writable"
      ? EXIT.notCommitted
      : EXIT.ok;
  } finally {
    stopListening?.();
    stopCloud();
    await runtime.dispose?.();
  }
}

type Ended = Pick<GenerateResult, "outcome" | "commitSha" | "reason">;

const MAX_REASON_CHARS = 1_000;

async function end(
  generated: Generated,
  dryRun: boolean,
  commit: (c: NonNullable<Generated["commit"]>) => Promise<CommitResult>,
): Promise<Ended> {
  if (!generated.commit) {
    const why = generated.skipped.map((s) => `${s.path}: ${s.reason}`).join("; ");
    return {
      outcome: "nothing",
      commitSha: null,
      reason: clip(why === "" ? "no changed source file to write for" : why),
    };
  }
  if (dryRun) return { outcome: "dry_run", commitSha: null, reason: null };
  const written = await commit(generated.commit);
  return written.committed
    ? { outcome: "committed", commitSha: written.sha, reason: null }
    : { outcome: written.outcome, commitSha: null, reason: clip(written.reason) };
}

function clip(text: string): string {
  return text.length > MAX_REASON_CHARS ? `${text.slice(0, MAX_REASON_CHARS - 1)}…` : text;
}

function said(result: GenerateResult): string {
  const files = `${result.files.length} file(s)`;
  switch (result.outcome) {
    case "committed":
      return `Committed ${result.commitSha?.slice(0, 12)} with ${files}`;
    case "dry_run":
      return `Dry run: ${files} not committed`;
    default:
      return `Nothing committed: ${forTerminal(result.reason ?? "")}`;
  }
}

function isKind(value: string | undefined): value is GenerateKind {
  return (GENERATE_KINDS as readonly string[]).includes(value ?? "");
}
