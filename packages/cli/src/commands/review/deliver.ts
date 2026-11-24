import { join, relative, resolve } from "node:path";
import { errorMessage } from "@open-cr-agent/core";
import { sendToCloud } from "../../cloud/review.js";
import { writeOutputFile } from "../../io/output-file.js";
import { VERSION } from "../../version.js";
import type { ReviewArgs } from "./args.js";
import type { ReviewDeps } from "./deps.js";
import type { ExecutedRun } from "./execute-run.js";
import { renderJson, renderText } from "./render.js";
import type { ResolvedRun, ReviewIo } from "./resolve-run.js";
import { renderSarif } from "./sarif.js";
import { CHANGE_REQUEST } from "./target.js";

// The report in the format asked for, to stdout or --output.
export async function writeReport(
  run: ResolvedRun,
  { report }: ExecutedRun,
  args: ReviewArgs,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<void> {
  const sessionDir = relative(deps.cwd, join(run.session.dir, run.session.id)) || ".";
  const rendered =
    args.format === "json"
      ? renderJson(report)
      : args.format === "sarif"
        ? renderSarif(report, VERSION)
        : renderText(report, sessionDir);
  if (args.output === undefined) {
    io.out.write(rendered);
  } else {
    await writeOutputFile(run.root, resolve(deps.cwd, args.output), rendered);
    io.err.write(`[ocra] Wrote ${args.output}\n`);
  }
  const hidden = report.remembered.filter((e) => e.source === "account").length;
  if (hidden > 0) io.err.write(`[ocra] ${hidden} finding(s) hidden by your ocra Cloud memory\n`);
}

// The change request shows the review running from the start to how it
// ended: published, interrupted or failed.
export async function executeShown(
  run: ResolvedRun,
  execute: () => Promise<ExecutedRun>,
): Promise<ExecutedRun> {
  const shown = run.target.publish && run.target.platform !== "local";
  if (!shown) return execute();
  for (const warning of (await run.vcs.started?.())?.warnings ?? []) run.warn(warning);
  const stopped = async (reason: string) => {
    for (const warning of (await run.vcs.stopped?.(reason))?.warnings ?? []) run.warn(warning);
  };
  let executed: ExecutedRun;
  try {
    executed = await execute();
  } catch (error) {
    await stopped(`The review failed: ${errorMessage(error)}`);
    throw error;
  }
  if (executed.interrupted) await stopped("The review was interrupted before it finished.");
  return executed;
}

// Publishes to the pull or merge request when asked, and uploads to ocra
// Cloud when signed in.
export async function deliver(
  run: ResolvedRun,
  executed: ExecutedRun,
  args: ReviewArgs,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<void> {
  const { target } = run;
  if (target.publish && target.platform !== "local") {
    const changeRequest = CHANGE_REQUEST[target.platform];
    // Stopping halfway could post the inline comments without the summary
    // that remembers them; a first Ctrl-C only warns.
    const stopHolding = deps.onInterrupt?.(() => {
      io.err.write(
        `[ocra] Publishing; Ctrl-C again quits now and may leave the ${changeRequest} half updated\n`,
      );
    });
    try {
      const published = await run.vcs.publish(executed.report);
      for (const warning of published.warnings) run.warn(warning);
    } finally {
      stopHolding?.();
    }
    io.err.write(`[ocra] Published the review to the ${changeRequest}\n`);
  }
  if (executed.cloudReview && run.signedInCloud && !args.noUpload) {
    await sendToCloud(executed.report, executed.cloudReview, run.signedInCloud, {
      source: target.platform,
      durationMs: deps.now() - executed.started,
      ...(target.changeRequestNumber === undefined
        ? {}
        : { changeRequestNumber: target.changeRequestNumber }),
      shareRepoName: run.config.cloud.shareRepoName === true,
      err: io.err,
      warn: run.warn,
    });
  }
}
