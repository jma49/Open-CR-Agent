import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  addUsage,
  CompletionError,
  type CompletionRequest,
  type CompletionResult,
  emptyUsage,
  type ModelTier,
  REVIEW_TOOLS,
  type ReviewContext,
  type RuntimeOptions,
  type Usage,
} from "@open-cr-agent/core";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { resolveOpencodeBinary } from "./binary.js";
import { withFailback } from "./failback.js";
import { ModelHealth, parseModel } from "./models.js";
import { type OpencodeServer, startOpencodeServer } from "./opencode-server.js";
import { sleep } from "./quota.js";
import { reviewTools } from "./review-tools.js";
import { missingCredentials, serverEnv } from "./server-env.js";
import type { SessionOutcome } from "./session-outcome.js";
import { type PromptInput, promptSession } from "./session-prompt.js";
import { startToolServer, type ToolServer } from "./tool-server.js";
import { createUntimedDispatcher, untimedFetch } from "./transport.js";

export const MCP_SERVER = "ocra";
const REVIEW_AGENT = "ocra-reviewer";
const HELPER_AGENT = "ocra-helper";
// Must not be empty: OpenCode falls back to its full coding prompt otherwise.
const REVIEW_AGENT_PROMPT =
  "You are a code review agent run by ocra. Follow the review instructions below.";
const HELPER_AGENT_PROMPT = "You answer exactly as the instructions below ask, with no tools.";
// Each step resends the whole conversation, so an unbounded loop is the
// largest cost risk. At 20 steps a quarter of the review tasks on Vertex
// ended at the cap and one golden bug was never found; at 30 it was found in
// both runs, for about a third more cost on average (2026-09-28). Most tasks
// finish in about 15 steps and never reach it.
export const MAX_AGENT_STEPS = 30;
// The helper answers in one step and has no tools. It still needs two:
// OpenCode appends an assistant message on an agent's last allowed step, and
// Gemini rejects a request that ends with a model turn (#66).
export const HELPER_AGENT_STEPS = 2;

// Sent once to a review agent that stopped before finishing (session-prompt.ts).
export const REVIEW_RESUME = {
  doneTool: `${MCP_SERVER}_${REVIEW_TOOLS.taskDone}`,
  maxSteps: MAX_AGENT_STEPS,
  message: `You stopped before finishing the review. Continue with the files in <ocra_review_files> you have not reviewed yet, report each confirmed issue with ${REVIEW_TOOLS.reportFinding}, and call ${REVIEW_TOOLS.taskDone} when every file is done.`,
};

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
  onExit: () => void;
  root: string;
  tools: ToolServer;
  server: OpencodeServer;
  client: OpencodeClient;
  dispatcher: ReturnType<typeof createUntimedDispatcher>;
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
      attempt: (model, onUsage) =>
        this.prompt(
          infra,
          {
            title: `ocra ${spec.taskId}`,
            agent: REVIEW_AGENT,
            model,
            system: spec.systemPrompt,
            user: spec.userPrompt,
            tools: DISABLED_BUILTINS,
            resume: REVIEW_RESUME,
          },
          signal,
          onUsage,
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
      for (;;) {
        await sleep(this.health.pausedFor(model), signal);
        if (signal.aborted) throw new CompletionError("cancelled", usage);
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
        if (!outcome.error.retryable) {
          throw new CompletionError(`${model}: ${outcome.error.message}`, usage);
        }
        if (outcome.error.quota && this.health.recordQuota(model, outcome.error.quota) === "wait") {
          continue;
        }
        if (!outcome.error.quota) this.health.recordFailure(model);
        lastError = `${model}: ${outcome.error.message}`;
        break;
      }
    }
    if (!lastError) {
      throw new CompletionError(`every ${request.tier} model is out of quota for this run`, usage);
    }
    throw new CompletionError(`every ${request.tier} model failed (${lastError})`, usage);
  }

  async dispose(): Promise<void> {
    const infra = await this.infra?.catch(() => undefined);
    this.infra = undefined;
    if (!infra) return;
    process.off("exit", infra.onExit);
    await Promise.allSettled([infra.server.close(), infra.tools.close(), infra.dispatcher.close()]);
    await rm(infra.root, { recursive: true, force: true });
  }

  private prompt(
    infra: Infra,
    input: PromptInput,
    signal: AbortSignal,
    onUsage?: (spent: Usage) => void,
  ): Promise<SessionOutcome> {
    return promptSession(
      infra.client.session,
      input,
      `${MCP_SERVER}_${REVIEW_TOOLS.reportFinding}`,
      signal,
      onUsage ? { onUsage } : {},
    );
  }

  private start(): Promise<Infra> {
    this.infra ??= this.launch();
    return this.infra;
  }

  private async launch(): Promise<Infra> {
    const missing = missingCredentials(this.options.env, providersOf(this.options.models));
    if (missing.length > 0) throw new Error(missing.join("; "));
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
    let started: OpencodeServer | undefined;
    try {
      const server = await startOpencodeServer({
        binary: this.options.binary ?? resolveOpencodeBinary(this.options.env),
        env: serverEnv(this.options.env, dirs, providersOf(this.options.models)),
        config: openCodeConfig(tools, this.helperTools),
      });
      started = server;
      const dispatcher = createUntimedDispatcher();
      const client = createOpencodeClient({
        baseUrl: server.url,
        directory: workspace,
        headers: { Authorization: server.authorization },
        fetch: untimedFetch(dispatcher),
      });
      // A second Ctrl-C exits at once, before dispose() can run: stop
      // OpenCode and remove its directory synchronously on the way out.
      const onExit = () => {
        server.killNow();
        rmSync(root, { recursive: true, force: true });
      };
      process.on("exit", onExit);
      return { root, tools, server, client, dispatcher, onExit };
    } catch (error) {
      await Promise.allSettled([tools.close(), started?.close()]);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}

export function openCodeConfig(
  tools: Pick<ToolServer, "url" | "headers">,
  helperTools: Record<string, boolean>,
) {
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
        steps: HELPER_AGENT_STEPS,
        tools: helperTools,
        permission,
      },
    },
  };
}

function providersOf(models: RuntimeOptions["models"]): string[] {
  return Object.values(models).flatMap((chain) =>
    (chain ?? []).map((m) => parseModel(m).providerID),
  );
}

function noModel(tier: ModelTier): string {
  return `No model configured for the "${tier}" tier; set models.${tier} in .ocra/config.json or OCRA_MODEL_${tier.toUpperCase()}`;
}
