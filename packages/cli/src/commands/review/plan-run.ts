import { resolve } from "node:path";
import { previewReview, toPlanOutput } from "@open-cr-agent/core/internal";
import { EXIT } from "../../io/exit.js";
import type { ReviewArgs } from "./args.js";
import type { ReviewDeps } from "./deps.js";
import { inputPriceOf } from "./plan-prices.js";
import { renderPlan } from "./plan-render.js";
import { safeJson } from "./render.js";
import type { ResolvedRun, ReviewIo } from "./resolve-run.js";
import { configuredOptions } from "./review-options.js";
import { accountOf, effectiveSettings, renderSettings } from "./settings-sources.js";

// --plan: what the review would do and cost, without calling a model.
export async function planRun(
  run: ResolvedRun,
  args: ReviewArgs,
  io: ReviewIo,
  deps: ReviewDeps,
): Promise<number> {
  const { config } = run;
  const preview = await previewReview({
    ...configuredOptions(run, args),
    vcs: run.vcs,
    inputPrice: inputPriceOf(config.providers),
  });
  const settings = effectiveSettings(run.listed);
  const rendered =
    args.format === "json"
      ? `${safeJson({ ...toPlanOutput(preview), settings, ...accountOf(run.accountSettings) })}\n`
      : renderPlan(preview) + renderSettings(settings, run.accountSettings);
  if (args.output === undefined) io.out.write(rendered);
  else await deps.writeFile(resolve(deps.cwd, args.output), rendered);
  return EXIT.ok;
}
