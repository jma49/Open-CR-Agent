import { parseArgs } from "node:util";
import { OcraError } from "@open-cr-agent/core";
import { answerMention } from "@open-cr-agent/core/internal";
import { EXIT } from "../io/exit.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import { changeOf } from "./change-flags.js";
import type { ReviewArgs } from "./review/args.js";
import type { ReviewDeps } from "./review/deps.js";
import { startRuntime } from "./review/execute-run.js";
import { type ReviewIo, resolveRun } from "./review/resolve-run.js";

export const REPLY_USAGE = `Usage: ocra reply (--pr <n> | --mr <n>) --comment <id> [options]

Answers a comment that mentions @ocra on a pull or merge request, in its
thread, with one helper model call. It answers only someone with write
access, once per comment, and never a comment someone else edited; for
anything else it says why on stderr and exits 0.

Options:
  --pr <n>            The GitHub pull request (needs GITHUB_TOKEN)
  --repo <owner/name> Its repository (default: GITHUB_REPOSITORY or origin)
  --mr <n>            The GitLab merge request (needs GITLAB_TOKEN)
  --project <id|path> Its project (default: CI_PROJECT_ID or origin)
  --comment <id>      The comment's id (GitLab: the note's id)
  --inline            GitHub: the comment is on a line of the diff
  -h, --help          Show help
`;

export async function replyCommand(
  argv: string[],
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      pr: { type: "string" },
      repo: { type: "string" },
      mr: { type: "string" },
      project: { type: "string" },
      comment: { type: "string" },
      inline: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    io.out.write(REPLY_USAGE);
    return EXIT.ok;
  }
  const change = changeOf(values, false);
  if (!change) throw new UsageError("ocra reply needs --pr or --mr");
  const id = values.comment?.trim();
  if (!id) throw new UsageError("ocra reply needs --comment");
  if (values.inline && !change.pullRequest) throw new UsageError("--inline goes with --pr");

  const reviewArgs: ReviewArgs = { target: { mode: "workspace" }, format: "text", ...change };
  const run = await resolveRun(reviewArgs, io, deps, { logged: false });
  if (!run.vcs.mention) {
    throw new OcraError("CONFIG_INVALID", "this platform cannot answer comments");
  }
  const mention = await run.vcs.mention({ id, ...(values.inline ? { inline: true } : {}) });
  if (!mention.asked) {
    io.err.write(`[ocra] Not answering: ${forTerminal(mention.reason)}\n`);
    return EXIT.ok;
  }
  const { runtime, stopCloud } = await startRuntime(run, deps, {});
  const stopListening = deps.onInterrupt?.(() => run.interrupt.abort());
  let spent = 0;
  try {
    await answerMention({
      vcs: run.vcs,
      mention,
      runtime,
      selection: { include: run.config.include, exclude: run.config.exclude },
      effort: run.config.effort,
      roles: run.config.roles,
      signal: run.interrupt.signal,
      onUsage: (usage) => (spent += usage.costUsd),
    });
    io.err.write(`[ocra] Answered ${forTerminal(mention.by)}; $${spent.toFixed(4)}\n`);
    return EXIT.ok;
  } finally {
    stopListening?.();
    stopCloud();
    await runtime.dispose?.();
  }
}
