import type { OcraPlugin } from "@open-cr-agent/core";
import {
  changeRequestSchema,
  codeSourceSchema,
  fetchSchema,
  historySchema,
} from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { DEFAULT_BOT_LOGIN, GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";

const optionsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  token: z.string().min(1),
  apiUrl: z.string().url().optional(),
  botLogin: z.string().min(1).default(DEFAULT_BOT_LOGIN),
  requestChanges: z.boolean().default(false),
  fetch: fetchSchema.optional(),
  code: codeSourceSchema,
  snapshot: changeRequestSchema.optional(),
  history: historySchema.optional(),
});

export const githubPlugin: OcraPlugin = {
  name: "vcs-github",
  configure(ctx) {
    ctx.registerVcs("github", (raw) => {
      const options = optionsSchema.parse(raw);
      const api = new GitHubApi(
        { owner: options.owner, repo: options.repo },
        {
          token: options.token,
          ...(options.apiUrl ? { baseUrl: options.apiUrl } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        },
      );
      return new GitHubAdapter({
        pullRequest: { owner: options.owner, repo: options.repo, number: options.number },
        api,
        code: options.code,
        botLogin: options.botLogin,
        requestChanges: options.requestChanges,
        ...(options.history ? { history: options.history } : {}),
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      });
    });
  },
};
