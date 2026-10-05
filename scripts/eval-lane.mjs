// The lanes of the free golden eval (eval-free.yml), one per line as
// "model<TAB>ref<TAB>tier<TAB>series": a scheduled run's in the order to try
// them, or a dispatch's one lane (an empty model is the first lane's).
//
//   node scripts/eval-lane.mjs schedule <slot>
//   node scripts/eval-lane.mjs dispatch <model> <ref> <tier>
import { readFileSync } from "node:fs";
import { errorMessage } from "./lib/error-message.mjs";
import { checkLane, laneLine, parseLanes, rotation } from "./lib/eval-lanes.mjs";

const [mode, ...args] = process.argv.slice(2);
try {
  const lanes = parseLanes(
    JSON.parse(readFileSync(new URL("../.github/eval-free-lanes.json", import.meta.url), "utf8")),
  );
  if (mode === "schedule" && (args[0] === "0" || args[0] === "1")) {
    for (const lane of rotation(lanes, new Date(), Number(args[0]))) console.log(laneLine(lane));
  } else if (mode === "dispatch" && args.length === 3) {
    const [model, ref, tier] = /** @type {[string, string, string]} */ (args);
    console.log(laneLine(checkLane(model || (lanes[0]?.model ?? ""), ref, tier)));
  } else {
    console.error(
      "usage: node scripts/eval-lane.mjs schedule <0|1> | dispatch <model> <ref> <tier>",
    );
    process.exit(2);
  }
} catch (error) {
  console.error(errorMessage(error));
  process.exit(1);
}
