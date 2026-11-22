import type { ProposeOptions, StackedChangeRequest, StackHost } from "@open-cr-agent/vcs-platform";
import { pickStacked } from "@open-cr-agent/vcs-platform";
import { z } from "zod";
import { githubApi } from "./target.js";

const pullSchema = z.object({
  number: z.number(),
  state: z.string(),
  merged_at: z.string().nullish(),
  title: z.string(),
  body: z.string().nullish(),
  html_url: z.string(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
});

function stacked(pull: z.infer<typeof pullSchema>): StackedChangeRequest {
  return {
    number: pull.number,
    head: pull.head.ref,
    base: pull.base.ref,
    state: pull.state === "open" ? "open" : pull.merged_at ? "merged" : "closed",
    title: pull.title,
    body: pull.body ?? "",
    webUrl: pull.html_url,
  };
}

// Pull requests from branches of the repository itself, never from forks.
// The token needs pull request write access, and contents read access.
export async function githubStackHost(options: ProposeOptions): Promise<StackHost> {
  const { api, owner } = await githubApi(options, options.repository, "ocra stack");
  return {
    async find(head) {
      const query = new URLSearchParams({ head: `${owner}:${head}`, state: "all", per_page: "20" });
      const pulls = z.array(pullSchema).parse(await api.request("GET", `/pulls?${query}`));
      return pickStacked(pulls.map(stacked));
    },
    async open({ head, base, title, body, draft }) {
      return stacked(
        pullSchema.parse(await api.request("POST", "/pulls", { head, base, title, body, draft })),
      );
    },
    async update(number, change) {
      await api.request("PATCH", `/pulls/${number}`, change);
    },
  };
}
