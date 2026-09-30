import type { OcraPlugin } from "@open-cr-agent/core";
import type { CodeSource, History } from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { GitLabAdapter } from "./adapter.js";
import { GitLabApi, type MergeRequest } from "./client.js";

const optionsSchema = z.object({
  // The project's numeric id or full path ("group/project").
  project: z.union([z.number().int().positive(), z.string().min(1)]),
  iid: z.number().int().positive(),
  token: z.string().min(1),
  apiUrl: z.string().url().optional(),
  fetch: z.custom<typeof fetch>((value) => typeof value === "function").optional(),
  code: z.custom<CodeSource>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      ["getDiff", "readFile", "searchCode"].every(
        (m) => typeof (value as Record<string, unknown>)[m] === "function",
      ),
    "code must provide getDiff, readFile and searchCode",
  ),
  snapshot: z
    .custom<MergeRequest>(
      (value) => typeof value === "object" && value !== null && "diff_refs" in value,
    )
    .optional(),
  history: z
    .custom<History>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        typeof (value as Record<string, unknown>).filesChangedSince === "function",
      "history must provide filesChangedSince",
    )
    .optional(),
});

export const gitlabPlugin: OcraPlugin = {
  name: "vcs-gitlab",
  configure(ctx) {
    ctx.registerVcs("gitlab", (raw) => {
      const options = optionsSchema.parse(raw);
      const api = new GitLabApi(options.project, {
        token: options.token,
        ...(options.apiUrl ? { baseUrl: options.apiUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      return new GitLabAdapter({
        iid: options.iid,
        api,
        code: options.code,
        ...(options.history ? { history: options.history } : {}),
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      });
    });
  },
};
