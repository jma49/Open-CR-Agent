import { z } from "zod";
import { agentsMdReviewer } from "../review/reviewers/agents-md.js";
import { correctnessReviewer } from "../review/reviewers/correctness.js";
import { docsReviewer } from "../review/reviewers/docs.js";
import { performanceReviewer } from "../review/reviewers/performance.js";
import { securityReviewer } from "../review/reviewers/security.js";
import { JsonlSessionWriter } from "../session/jsonl.js";
import { SEAL_KEY } from "../session/seal.js";
import type { OcraPlugin } from "./types.js";

export const correctnessReviewerPlugin: OcraPlugin = {
  name: "reviewer-correctness",
  configure(ctx) {
    ctx.registerReviewer(correctnessReviewer);
  },
};

export const securityReviewerPlugin: OcraPlugin = {
  name: "reviewer-security",
  configure(ctx) {
    ctx.registerReviewer(securityReviewer);
  },
};

export const performanceReviewerPlugin: OcraPlugin = {
  name: "reviewer-performance",
  configure(ctx) {
    ctx.registerReviewer(performanceReviewer);
  },
};

export const docsReviewerPlugin: OcraPlugin = {
  name: "reviewer-docs",
  configure(ctx) {
    ctx.registerReviewer(docsReviewer);
  },
};

export const agentsMdReviewerPlugin: OcraPlugin = {
  name: "reviewer-agents-md",
  configure(ctx) {
    ctx.registerReviewer(agentsMdReviewer);
  },
};

// sealKey: this machine's secret (64 hex digits) that seals each line, so
// that only this machine's ocra resumes the session.
const sessionSettings = z
  .object({
    dir: z.string().min(1),
    id: z.string().min(1),
    sealKey: z.string().regex(SEAL_KEY).exactOptional(),
  })
  .strict();

export const sessionJsonlPlugin: OcraPlugin<z.infer<typeof sessionSettings>> = {
  name: "session-jsonl",
  settingsSchema: sessionSettings,
  configure(ctx) {
    const { dir, id, sealKey } = ctx.settings;
    const writer = new JsonlSessionWriter(dir, id, sealKey);
    ctx.onEvent((event) => writer.write(event));
  },
};
