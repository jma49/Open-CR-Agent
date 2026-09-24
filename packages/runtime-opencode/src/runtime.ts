import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  REVIEW_TOOLS,
  type ReviewContext,
  type RuntimeOptions,
} from "@open-cr-agent/core";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { resolveOpencodeBinary } from "./binary.js";
import { withFailback } from "./failback.js";
import { ModelHealth, parseModel } from "./models.js";
import { type OpencodeServer, startOpencodeServer } from "./opencode-server.js";
import { reviewTools } from "./review-tools.js";
import { serverEnv } from "./server-env.js";
import { type SessionMessage, type SessionOutcome, summarizeSession } from "./session-outcome.js";
import { startToolServer, type ToolServer } from "./tool-server.js";

export const MCP_SERVER = "ocra";
const AGENT = "ocra-reviewer";
// Must not be empty: OpenCode falls back to its full coding prompt otherwise.
const AGENT_PROMPT =
  "You are a code review agent run by ocra. Follow the review instructions below.";
// Each step resends the whole conversation, so an unbounded loop is the
// largest cost risk; 20 steps is ample for a bundle of at most ten files.
export const MAX_AGENT_STEPS = 20;

// Every OpenCode built-in tool of the pinned version; a test fails when an
// upgrade adds one, so a new write-capable tool can never be enabled silently.
export const OPENCODE_BUILTIN_TOOLS = [
  "invalid",
  "question",
  "bash",
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "task",
  "webfetch",
  "todowrite",
  "websearch",
  "skill",
  "apply_patch",
] as const;
const DISABLED_TOOLS = Object.fromEntries(OPENCODE_BUILTIN_TOOLS.map((t) => [t, false]));

export interface OpenCodeRuntimeOptions extends RuntimeOptions {
  binary?: string;
}

interface Infra {
  root: string;
  tools: ToolServer;
  server: OpencodeServer;
  client: OpencodeClient;
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";
  private infra: Promise<Infra> | undefined;
  private context: ReviewContext | undefined;
  private readonly health = new ModelHealth();

  constructor(private readonly options: OpenCodeRuntimeOptions) {}

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.context && this.context !== spec.context) {
      throw new Error("An OpenCodeRuntime instance serves a single review run");
    }
    this.context = spec.context;
    const taskId = spec.taskId;

    const chain = this.options.models[spec.modelTier] ?? [];
    if (chain.length === 0) {
      const tier = spec.modelTier;
      yield {
        type: "error",
        taskId,
        retryable: false,
        error: `No model configured for the "${tier}" tier; set models.${tier} in .ocra/config.json or OCRA_MODEL_${tier.toUpperCase()}`,
      };
      return;
    }

    const infra = await this.start();
    yield* withFailback({
      taskId,
      tier: spec.modelTier,
      chain,
      health: this.health,
      signal,
      attempt: (model) => this.runOnce(infra, spec, model, signal),
    });
  }

  async dispose(): Promise<void> {
    const infra = await this.infra?.catch(() => undefined);
    this.infra = undefined;
    if (!infra) return;
    await Promise.allSettled([infra.server.close(), infra.tools.close()]);
    await rm(infra.root, { recursive: true, force: true });
  }

  private async runOnce(
    infra: Infra,
    spec: AgentTaskSpec,
    model: string,
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    const { client } = infra;
    const created = await client.session.create({ title: `ocra ${spec.taskId}` }, { signal });
    if (!created.data)
      throw new Error(`OpenCode could not create a session: ${JSON.stringify(created.error)}`);
    const sessionID = created.data.id;

    const abort = () => void client.session.abort({ sessionID }).catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await client.session.prompt(
        {
          sessionID,
          agent: AGENT,
          model: parseModel(model),
          system: spec.systemPrompt,
          tools: DISABLED_TOOLS,
          parts: [{ type: "text", text: spec.userPrompt }],
        },
        { signal },
      );
      if (response.error) {
        return {
          ...emptyOutcome(),
          error: { message: JSON.stringify(response.error), retryable: false },
        };
      }
      const messages = await client.session.messages({ sessionID }, { signal });
      return summarizeSession(
        (messages.data ?? []) as SessionMessage[],
        `${MCP_SERVER}_${REVIEW_TOOLS.reportFinding}`,
      );
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private start(): Promise<Infra> {
    this.infra ??= this.launch();
    return this.infra;
  }

  private async launch(): Promise<Infra> {
    const root = await mkdtemp(join(tmpdir(), "ocra-opencode-"));
    const dirs = {
      config: join(root, "config"),
      data: join(root, "data"),
      state: join(root, "state"),
    };
    const workspace = join(root, "workspace");
    await Promise.all(
      [...Object.values(dirs), workspace].map((d) => mkdir(d, { recursive: true })),
    );

    const tools = await startToolServer(
      [...reviewTools, ...this.options.tools],
      () => this.context,
    );
    try {
      const server = await startOpencodeServer({
        binary: this.options.binary ?? resolveOpencodeBinary(this.options.env),
        env: serverEnv(this.options.env, dirs, {}),
        config: openCodeConfig(tools),
      });
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: workspace,
        headers: { Authorization: server.authorization },
      });
      return { root, tools, server, client };
    } catch (error) {
      await tools.close();
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}

function openCodeConfig(tools: ToolServer) {
  return {
    share: "disabled",
    autoupdate: false,
    mcp: {
      [MCP_SERVER]: {
        type: "remote",
        url: tools.url,
        headers: tools.headers,
        oauth: false,
        enabled: true,
      },
    },
    agent: {
      [AGENT]: {
        mode: "primary",
        prompt: AGENT_PROMPT,
        steps: MAX_AGENT_STEPS,
        tools: DISABLED_TOOLS,
        permission: { edit: "deny", bash: "deny", webfetch: "deny", skill: "deny" },
      },
    },
  };
}

function emptyOutcome(): SessionOutcome {
  return {
    findings: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, costUsd: 0 },
  };
}
