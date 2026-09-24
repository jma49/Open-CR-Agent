import { z } from "zod";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { JsonlSessionWriter } from "../session/jsonl.js";
import type { OcraPlugin } from "./types.js";

export const correctnessReviewerPlugin: OcraPlugin = {
  name: "reviewer-correctness",
  configure(ctx) {
    ctx.registerReviewer(correctnessReviewer);
  },
};

const sessionSettings = z.object({ dir: z.string().min(1), id: z.string().min(1) }).strict();

export const sessionJsonlPlugin: OcraPlugin<z.infer<typeof sessionSettings>> = {
  name: "session-jsonl",
  settingsSchema: sessionSettings,
  configure(ctx) {
    const writer = new JsonlSessionWriter(ctx.settings.dir, ctx.settings.id);
    ctx.onEvent((event) => writer.write(event));
  },
};
