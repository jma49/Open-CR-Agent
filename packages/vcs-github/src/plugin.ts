import type { OcraPlugin } from "@open-cr-agent/core";
import { z } from "zod";
import { GitHubAdapter } from "./adapter.js";

const optionsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
});

export const githubPlugin: OcraPlugin = {
  name: "vcs-github",
  configure(ctx) {
    ctx.registerVcs("github", (options) => new GitHubAdapter(optionsSchema.parse(options)));
  },
};
