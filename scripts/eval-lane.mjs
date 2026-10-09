// Picks the lane of a free golden eval run (eval-free.yml): a scheduled
// run's first lane, in the order of the day's rotation, whose branch exists
// in this repository, or a dispatch's one lane (an empty model is the first
// lane's). Writes its model, ref, tier and series as step outputs, and the
// lane to the job summary.
//
//   node scripts/eval-lane.mjs schedule <slot>
//   node scripts/eval-lane.mjs dispatch <model> <ref> <tier>
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { errorMessage } from "./lib/error-message.mjs";
import {
  checkLane,
  laneOutputs,
  parseLanes,
  pickLane,
  rotation,
  seriesName,
} from "./lib/eval-lanes.mjs";

const repository = process.env.GITHUB_REPOSITORY ?? "jma49/Open-CR-Agent";

/** @param {string} ref */
function branchExists(ref) {
  const url = `https://github.com/${repository}.git`;
  return new Promise((resolve) => {
    execFile("git", ["ls-remote", "--exit-code", "--heads", url, `refs/heads/${ref}`], (error) =>
      resolve(!error),
    );
  });
}

/** @param {string[]} argv */
function candidates([mode, ...args]) {
  const lanes = parseLanes(
    JSON.parse(readFileSync(new URL("../.github/eval-free-lanes.json", import.meta.url), "utf8")),
  );
  if (mode === "schedule" && (args[0] === "0" || args[0] === "1")) {
    return rotation(lanes, new Date(), Number(args[0]));
  }
  if (mode === "dispatch" && args.length === 3) {
    const [model, ref, tier] = /** @type {[string, string, string]} */ (args);
    return [checkLane(model || (lanes[0]?.model ?? ""), ref, tier)];
  }
  return undefined;
}

try {
  const lanes = candidates(process.argv.slice(2));
  if (!lanes) {
    console.error(
      "usage: node scripts/eval-lane.mjs schedule <0|1> | dispatch <model> <ref> <tier>",
    );
    process.exit(2);
  }
  const { lane, passedOver } = await pickLane(lanes, branchExists);
  for (const { ref } of passedOver) {
    console.log(
      `::warning title=Lane passed over::${ref} is not a branch of ${repository}; remove its lane from .github/eval-free-lanes.json`,
    );
  }
  if (!lane) {
    console.log("::error::no lane to evaluate");
    process.exit(1);
  }
  const outputs = `${laneOutputs(lane)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, outputs);
  else process.stdout.write(outputs);
  const summary = `Lane: \`${lane.model}\` on \`${lane.ref}\`, ${lane.tier} tier (${seriesName(lane)}).\n`;
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}
