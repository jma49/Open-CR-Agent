import type { OcraPlugin } from "@open-cr-agent/core";
import { z } from "zod";
import { type CodeSource, DEFAULT_BOT_LOGIN, GitHubAdapter } from "./adapter.js";
import { GitHubApi } from "./client.js";

const optionsSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  number: z.number().int().positive(),
  token: z.string().min(1),
  apiUrl: z.string().url().optional(),
  botLogin: z.string().min(1).default(DEFAULT_BOT_LOGIN),
  requestChanges: z.boolean().default(false),
  code: z.custom<CodeSource>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      ["getDiff", "readFile", "searchCode"].every(
        (m) => typeof (value as Record<string, unknown>)[m] === "function",
      ),
    "code must provide getDiff, readFile and searchCode",
  ),
});

export const githubPlugin: OcraPlugin = {
  name: "vcs-github",
  configure(ctx) {
    ctx.registerVcs("github", (raw) => {
      const options = optionsSchema.parse(raw);
      const api = new GitHubApi(
        { owner: options.owner, repo: options.repo },
        options.apiUrl
          ? { token: options.token, baseUrl: options.apiUrl }
          : { token: options.token },
      );
      return new GitHubAdapter({
        pullRequest: { owner: options.owner, repo: options.repo, number: options.number },
        api,
        code: options.code,
        botLogin: options.botLogin,
        requestChanges: options.requestChanges,
      });
    });
  },
};
