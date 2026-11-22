import type { TrackersConfig } from "@open-cr-agent/cloud-contract";
import type { Env, TaskSource } from "@open-cr-agent/core";
import { jiraKeys, tapdKey, tapdKeys } from "./keys.js";
import { mcpTaskSource } from "./mcp-source.js";

// The configured trackers as task sources, Jira before TAPD.
export function trackerSources(
  trackers: TrackersConfig | undefined,
  env: Env,
  fetchImpl?: typeof fetch,
): TaskSource[] {
  const sources: TaskSource[] = [];
  const { jira, tapd } = trackers ?? {};
  if (jira) {
    sources.push(
      mcpTaskSource(
        {
          tracker: "jira",
          server: jira.server,
          keysIn: jiraKeys(jira.projects),
          call: (key) => ({
            tool: jira.tool,
            arguments: { ...jira.arguments, [jira.keyArgument]: key },
          }),
        },
        env,
        fetchImpl,
      ),
    );
  }
  if (tapd) {
    sources.push(
      mcpTaskSource(
        {
          tracker: "tapd",
          server: tapd.server,
          keysIn: tapdKeys(tapd.workspace),
          call: (key) => {
            const parsed = tapdKey(key);
            const tool = parsed && tapd.tools[parsed.kind];
            if (!parsed || !tool) return undefined;
            return {
              tool,
              arguments: {
                workspace_id: tapd.workspace,
                ...tapd.arguments,
                [tapd.keyArgument]: parsed.id,
              },
            };
          },
        },
        env,
        fetchImpl,
      ),
    );
  }
  return sources;
}
