import type { ProposeOptions, StackedChangeRequest, StackHost } from "@open-cr-agent/vcs-platform";
import { pickStacked } from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { gitlabApi } from "./target.js";

const mergeRequestSchema = z.object({
  iid: z.number(),
  state: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  web_url: z.string(),
  source_branch: z.string(),
  target_branch: z.string(),
});

function stacked(request: z.infer<typeof mergeRequestSchema>): StackedChangeRequest {
  return {
    number: request.iid,
    head: request.source_branch,
    base: request.target_branch,
    state: request.state === "opened" ? "open" : request.state === "merged" ? "merged" : "closed",
    title: request.title,
    body: request.description ?? "",
    webUrl: request.web_url,
  };
}

// Merge requests between branches of the project itself. The token needs
// the api scope and the Developer role.
export async function gitlabStackHost(
  options: ProposeOptions,
  warn: (message: string) => void,
): Promise<StackHost> {
  const { api } = await gitlabApi({ ...options, warn }, options.repository, "ocra stack");
  return {
    async find(head) {
      const query = new URLSearchParams({ source_branch: head, per_page: "20" });
      const requests = z
        .array(mergeRequestSchema)
        .parse(await api.request("GET", `/merge_requests?${query}`));
      return pickStacked(requests.map(stacked));
    },
    async open({ head, base, title, body, draft }) {
      return stacked(
        mergeRequestSchema.parse(
          await api.request("POST", "/merge_requests", {
            source_branch: head,
            target_branch: base,
            title: draft ? `Draft: ${title}` : title,
            description: body,
            remove_source_branch: true,
          }),
        ),
      );
    },
    async update(number, change) {
      await api.request("PUT", `/merge_requests/${number}`, {
        ...(change.base !== undefined ? { target_branch: change.base } : {}),
        ...(change.body !== undefined ? { description: change.body } : {}),
      });
    },
  };
}
