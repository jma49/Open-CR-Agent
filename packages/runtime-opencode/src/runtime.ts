import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  addUsage,
  type CompletionRequest,
  type CompletionResult,
  emptyUsage,
  type ModelTier,
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
const REVIEW_AGENT = "ocra-reviewer";
const HELPER_AGENT = "ocra-helper";
// Must not be empty: OpenCode falls back to its full coding prompt otherwise.
const REVIEW_AGENT_PROMPT =
  "You are a code review agent run by ocra. Follow the review instructions below.";
const HELPER_AGENT_PROMPT = "You answer exactly as the instructions below ask, with no tools.";
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
const DISABLED_BUILTINS = Object.fromEntries(OPENCODE_BUILTIN_TOOLS.map((t) => [t, false]));

export interface OpenCodeRuntimeOptions extends RuntimeOptions {
  binary?: string;
}

interface Infra {
  root: string;
  tools: ToolServer;
  server: OpencodeServer;
  client: OpencodeClient;
}

interface PromptInput {
  title: string;
  agent: string;
  model: string;
  system: string;
  user: string;
  tools: Record<string, boolean>;
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";
  private infra: Promise<Infra> | undefined;
  private context: ReviewContext | undefined;
  private readonly health = new ModelHealth();
  private readonly helperTools: Record<string, boolean>;

  constructor(private readonly options: OpenCodeRuntimeOptions) {
    const mcpTools = [...reviewTools, ...options.tools].map((t) => [
      `${MCP_SERVER}_${t.name}`,
      false,
    ]);
    this.helperTools = { ...DISABLED_BUILTINS, ...Object.fromEntries(mcpTools) };
  }

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.context && this.context !== spec.context) {
      throw new Error("An OpenCodeRuntime instance serves a single review run");
    }
    this.context = spec.context;

    const chain = this.options.models[spec.modelTier] ?? [];
    if (chain.length === 0) {
      yield {
        type: "error",
        taskId: spec.taskId,
        retryable: false,
        error: noModel(spec.modelTier),
      };
      return;
    }

    const infra = await this.start();
    yield* withFailback({
      taskId: spec.taskId,
      tier: spec.modelTier,
      chain,
      health: this.health,
      signal,
      attempt: (model) =>
        this.prompt(
          infra,
          {
            title: `ocra ${spec.taskId}`,
            agent: REVIEW_AGENT,
            model,
            system: spec.systemPrompt,
            user: spec.userPrompt,
            tools: DISABLED_BUILTINS,
          },
          signal,
        ),
    });
  }

  async complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const chain = this.options.models[request.tier] ?? [];
    if (chain.length === 0) throw new Error(noModel(request.tier));

    const infra = await this.start();
    let usage = emptyUsage();
    let lastError = "";
    for (const model of this.health.order(chain)) {
      const outcome = await this.prompt(
        infra,
        {
          title: "ocra helper",
          agent: HELPER_AGENT,
          model,
          system: request.system,
          user: request.user,
          tools: this.helperTools,
        },
        signal,
      );
      usage = addUsage(usage, outcome.usage);
      if (!outcome.error) {
        this.health.recordSuccess(model);
        return { text: outcome.text, usage };
      }
      if (!outcome.error.retryable) throw new Error(`${model}: ${outcome.error.message}`);
      this.health.recordFailure(model);
      lastError = `${model}: ${outcome.error.message}`;
    }
    throw new Error(`every ${request.tier} model failed (${lastError})`);
  }

  async dispose(): Promise<void> {
    const infra = await this.infra?.catch(() => undefined);
    this.infra = undefined;
    if (!infra) return;
    await Promise.allSettled([infra.server.close(), infra.tools.close()]);
    await rm(infra.root, { recursive: true, force: true });
  }

  private async prompt(
    infra: Infra,
    input: PromptInput,
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    const { client } = infra;
    const created = await client.session.create({ title: input.title }, { signal });
    if (!created.data) {
      throw new Error(`OpenCode could not create a session: ${JSON.stringify(created.error)}`);
    }
    const sessionID = created.data.id;

    const abort = () => void client.session.abort({ sessionID }).catch(() => {});
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await client.session.prompt(
        {
          sessionID,
          agent: input.agent,
          model: parseModel(input.model),
          system: input.system,
          tools: input.tools,
          parts: [{ type: "text", text: input.user }],
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
        config: openCodeConfig(tools, this.helperTools),
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

function openCodeConfig(tools: ToolServer, helperTools: Record<string, boolean>) {
  const permission = { edit: "deny", bash: "deny", webfetch: "deny", skill: "deny" };
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
      [REVIEW_AGENT]: {
        mode: "primary",
        prompt: REVIEW_AGENT_PROMPT,
        steps: MAX_AGENT_STEPS,
        tools: DISABLED_BUILTINS,
        permission,
      },
      [HELPER_AGENT]: {
        mode: "primary",
        prompt: HELPER_AGENT_PROMPT,
        steps: 1,
        tools: helperTools,
        permission,
      },
    },
  };
}

function noModel(tier: ModelTier): string {
  return `No model configured for the "${tier}" tier; set models.${tier} in .ocra/config.json or OCRA_MODEL_${tier.toUpperCase()}`;
}

function emptyOutcome(): SessionOutcome {
  return { findings: [], toolCalls: [], text: "", usage: emptyUsage() };
}
