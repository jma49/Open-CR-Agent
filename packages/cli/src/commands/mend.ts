import { parseArgs } from "node:util";
import {
  MEND_LEVELS,
  type MendLevel,
  type MendResult,
  mendFindingsSchema,
  mendResultSchema,
  mendStateSchema,
} from "@open-cr-agent/cloud-contract";
import { treeSitterSyntax } from "@open-cr-agent/code-graph";
import { addUsage, emptyUsage, type Usage } from "@open-cr-agent/core";
import { type MendRound, mendRound, type StoredFinding } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { changeOf } from "./change-flags.js";
import { expectedHead, maxCost, readJsonInput, storedFinding } from "./fix-input.js";
import { parseLocalTarget, type ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

export const MEND_USAGE = `Usage: ocra mend (--pr <n> | --mr <n> | --from <ref> [--to <ref>] | --commit <sha>)
                 (--findings <file|-> | --checks | --conflicts) [options]

Runs one round of the fix loop over findings a person accepted: each open
finding gets one fixer model call, as ocra fix makes it, or, when that
cannot place a local edit, a fixer task on the direct runtime whose one
edit tool writes to a copy of the head in memory; the edit must pass
the gate (a file of the change that is not protected, no test turned off,
small, committable, parses no worse) and one verifier model call; the edits
that pass become one commit on top of the head they were made at, or are
printed for a person to commit. Nothing from the repository runs: the
change's own checks test the commit. ocra never force-pushes, approves or
merges.

With --checks the round also works on the checks that failed on the head
of a pull or merge request and do not fail on its base branch: at most 3,
each as a fixer task that reads the last 200 lines of the failed job's log
as data. ocra reads the log and runs nothing. While checks are still
running and nothing else is open, the round does nothing and counts as
none (outcome "waiting").

With --conflicts the round first reads, in the local clone, whether the
base branch merges into the head of the pull or merge request. When it
does not, the round works on the conflicts alone: one fixer call per
conflicted file answers each conflicted region, code puts the file
together, and one verifier call checks it. Only when every conflicted file
is resolved is the merge written: printed at --level propose, or pushed as
one merge commit with both parents at --level commit, without force. At
most 5 files with text conflicts; a deleted, renamed or binary file leaves
the merge to a person.

A round works on at most 5 items, 10 files and 200 added lines. An item
gets 2 attempts and a change 6 rounds; --state carries the counts from one
round to the next. A failed check is the same item while it fails the same
way.

Options:
  --findings <file|-> The accepted findings as a JSON array, the most
                      important first, as ocra Cloud stores them
                      (sharedFindingSchema); - reads it from stdin
  --checks            Also work on the head's failed checks (on GitHub the
                      token needs actions: read for a job's log)
  --conflicts         First resolve the conflicts of merging the base branch
                      (--level commit needs a clone that can push)
  --level <level>     propose (default): print the checked edits, commit
                      nothing; commit: write them to the branch
  --state <file>      The state the last round printed (omit for the first)
  --head <sha>        The head the findings were reviewed at: if the
                      change's head is another, write nothing and exit 3
  --protect <glob>    A path no round may edit, besides the built-in ones
                      (CI configuration, .ocra/, manifests, migrations,
                      generated files); repeatable
  --pr <n>            The GitHub pull request (needs GITHUB_TOKEN)
  --repo <owner/name> Its repository (default: GITHUB_REPOSITORY or origin)
  --mr <n>            The GitLab merge request (needs GITLAB_TOKEN)
  --project <id|path> Its project (default: CI_PROJECT_ID or origin)
  --from <ref>        A local range: the changes on --to since <ref>
  --to <ref>          End of the range (default: HEAD)
  --commit <sha>      A local commit against its parent
  --config <file>     Read this configuration file instead of the
                      repository's .ocra/config.json
  --max-cost-usd <n>  Spend limit for the change's rounds together, the
                      state's spend included (default: maxCostUsd in config)
  --json              Print one line of JSON with the outcome on stdout
  -h, --help          Show help

Exit codes: 0 a commit, proposed edits, nothing to write, checks still
running, or a cap reached (the output says which); 3 the head moved or the branch cannot be written
to; 2 usage, input or configuration errors, or a runtime that cannot start.
`;

const MAX_FINDINGS_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_PROTECTED = 100;
const MAX_CHECK_NAME_CHARS = 200;

export async function mendCommand(argv: string[], io: ReviewIo, deps: ReviewDeps): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      findings: { type: "string" },
      checks: { type: "boolean" },
      conflicts: { type: "boolean" },
      level: { type: "string" },
      state: { type: "string" },
      head: { type: "string" },
      protect: { type: "string", multiple: true },
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
    io.out.write(MEND_USAGE);
    return EXIT.ok;
  }
  const change = changeOf(values, false);
  const target = parseLocalTarget(values);
  if (change && target.mode !== "workspace") {
    throw new UsageError("--pr and --mr cannot be combined with --from, --to or --commit");
  }
  if (!change && target.mode === "workspace") {
    throw new UsageError("ocra mend needs --pr, --mr, --from or --commit");
  }
  if (!values.findings && !values.checks && !values.conflicts) {
    throw new UsageError("ocra mend needs --findings <file|->, --checks or --conflicts");
  }
  if ((values.checks || values.conflicts) && !change) {
    throw new UsageError("--checks and --conflicts need --pr or --mr");
  }
  const level = levelOf(values.level);
  const head = expectedHead(values.head);
  const protectedPaths = values.protect ?? [];
  if (protectedPaths.length > MAX_PROTECTED || protectedPaths.some((p) => p === "")) {
    throw new UsageError(`--protect takes a glob, at most ${MAX_PROTECTED} times`);
  }
  if (values.config === "") throw new UsageError("--config needs a file");
  if (values.state === "" || values.state === "-") throw new UsageError("--state needs a file");
  const maxCostUsd = maxCost(values["max-cost-usd"]);
  const findings = values.findings
    ? (
        await readJsonInput(values.findings, deps, {
          flag: "--findings",
          what: "a list of findings",
          schema: mendFindingsSchema,
          maxBytes: MAX_FINDINGS_BYTES,
        })
      ).map(storedFinding)
    : [];
  const state =
    values.state === undefined
      ? undefined
      : await readJsonInput(values.state, deps, {
          flag: "--state",
          what: "a state ocra mend printed",
          schema: mendStateSchema,
          maxBytes: MAX_STATE_BYTES,
        });

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
    const round = await mendRound({
      findings,
      ...(values.checks ? { checks: true } : {}),
      ...(values.conflicts ? { conflicts: true } : {}),
      vcs: run.vcs,
      runtime,
      syntax: treeSitterSyntax(),
      level,
      effort: run.config.effort,
      roles: run.config.roles,
      protectedPaths,
      ...(state ? { state } : {}),
      ...(head !== undefined ? { expectedHead: head } : {}),
      ...(limit !== undefined ? { maxCostUsd: limit } : {}),
      signal: run.interrupt.signal,
      onUsage: (spent) => (usage = addUsage(usage, spent)),
    });
    if (run.interrupt.signal.aborted) return EXIT.interrupted;
    for (const warning of round.warnings) run.warn(warning);
    const result = mendResultSchema.parse(resultOf(round, usage));
    if (values.json) io.out.write(`${JSON.stringify(result)}\n`);
    else for (const line of itemLines(result, findings)) io.out.write(`${line}\n`);
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

function levelOf(value: string | undefined): MendLevel {
  if (value === undefined) return "propose";
  const level = MEND_LEVELS.find((l) => l === value);
  if (!level) throw new UsageError(`--level must be one of ${MEND_LEVELS.join(", ")}`);
  return level;
}

function resultOf(round: MendRound, usage: Usage): MendResult {
  return {
    headSha: round.headSha,
    outcome: round.outcome,
    stopped: round.stopped ?? null,
    commitSha: round.sha ?? null,
    mergeParent: round.mergeParent ?? null,
    items: round.items.map((item) => ({
      fingerprint: item.id,
      check: item.check?.slice(0, MAX_CHECK_NAME_CHARS) ?? null,
      conflict: item.conflict ?? null,
      resolved: item.resolved ?? null,
      regions: (item.regions ?? []).map((r) => ({
        line: r.line,
        ours: r.ours.join("\n"),
        theirs: r.theirs.join("\n"),
        resolved: r.lines.join("\n"),
      })),
      outcome: item.outcome,
      reason: item.reason ?? null,
      cause: item.cause ?? null,
      edits: (item.edits ?? []).map((e) => ({ ...e })),
    })),
    state: round.state,
    usage,
  };
}

function itemLines(result: MendResult, findings: readonly StoredFinding[]): string[] {
  const file = new Map(findings.map((f) => [f.fingerprint, f.file]));
  return result.items.map((item) => {
    const where = item.edits[0]
      ? `${item.edits[0].path}:${item.edits[0].startLine}-${item.edits[0].endLine}`
      : item.conflict !== null
        ? `conflict ${item.conflict.replace(/\s+/g, " ")}`
        : (file.get(item.fingerprint) ?? "");
    const why = item.reason ? ` (${item.reason}${item.cause ? `: ${item.cause}` : ""})` : "";
    const what =
      item.check === null ? where : `check ${item.check.replace(/\s+/g, " ")} ${where}`.trimEnd();
    return `${item.outcome}${why}  ${forTerminal(what)}  ${item.fingerprint}`;
  });
}

function said(result: MendResult): string {
  const count = (...outcomes: string[]) =>
    result.items.filter((i) => outcomes.includes(i.outcome)).length;
  const noun = result.items.some((i) => i.check !== null || i.conflict !== null)
    ? "item"
    : "finding";
  const of = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  switch (result.outcome) {
    case "committed":
      return `Committed ${result.commitSha?.slice(0, 12)} with fixes for ${of(count("fixed"))}`;
    case "proposed":
      return `Proposed fixes for ${of(count("proposed"))}, nothing committed`;
    case "nothing":
      return `Nothing to commit for ${of(result.items.length)}`;
    case "stopped":
      return `No round: the change reached its ${result.stopped} cap`;
    case "head_moved":
      return "Nothing committed: the head moved";
    case "not_writable":
      return "Nothing committed: the branch cannot be written to";
    case "waiting":
      return "No round: the head's checks are still running";
  }
}
