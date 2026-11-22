import { roleCall } from "../agent/settings.js";
import type { Usage } from "../contracts.js";
import { type Walkthrough, writeWalkthrough } from "../walkthrough/walkthrough.js";
import type { StageContext } from "./execute-stage.js";

export interface WalkthroughStage {
  walkthrough?: Walkthrough;
  usage: Usage[];
  warnings: string[];
}

// Runs beside the review tasks: it reads only the plan, and never rejects.
export async function walkthroughStage({
  options,
  settings,
  plan,
  spendLimit,
  signal,
}: StageContext): Promise<WalkthroughStage> {
  if (!settings.walkthrough || !spendLimit.mayCall()) return { usage: [], warnings: [] };
  const usage: Usage[] = [];
  const result = await writeWalkthrough({
    runtime: options.runtime,
    changeRequest: plan.changeRequest,
    files: plan.selected,
    signal,
    onUsage: (u) => {
      usage.push(u);
      spendLimit.charge(u);
    },
    call: roleCall("writer", options),
  });
  return { ...result, usage };
}
