import { conformance, type Scenario } from "../../vcs-platform/src/conformance.fakes.js";
import { adapter, bodies, fakeGitLab } from "./adapter.fakes.js";

// The scenario behind GitLab's REST and GraphQL APIs.
function onGitLab(scenario: Scenario) {
  const { calls, fetchImpl } = fakeGitLab(scenario);
  return {
    review: adapter(fetchImpl),
    inline: () => bodies(calls, "POST", "/merge_requests/7/discussions"),
    summary: () =>
      [
        ...bodies(calls, "POST", "/merge_requests/7/notes"),
        ...calls
          .filter((c) => c.method === "PUT" && c.path.includes("/notes/"))
          .map((c) => (c.body as { body: string }).body),
      ].at(-1) ?? "",
  };
}

conformance("GitLab", { conversation: onGitLab });
