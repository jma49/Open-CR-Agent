import type { OcraPlugin } from "@open-cr-agent/core";
import {
  changeRequestSchema,
  codeSourceSchema,
  commitIdSchema,
  fetchSchema,
  historySchema,
  signalSchema,
} from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { GitLabAdapter } from "./adapter.js";
import { GitLabApi } from "./client.js";

const optionsSchema = z.object({
  // The project's numeric id or full path ("group/project").
  project: z.union([z.number().int().positive(), z.string().min(1)]),
  iid: z.number().int().positive(),
  token: z.string().min(1),
  apiUrl: z.string().url().optional(),
  fetch: fetchSchema.optional(),
  signal: signalSchema.optional(),
  code: codeSourceSchema,
  snapshot: changeRequestSchema.extend({ mergeBaseSha: commitIdSchema }).optional(),
  history: historySchema.optional(),
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
        ...(options.signal ? { signal: options.signal } : {}),
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
