import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  type AppliedSampling,
  type CompletionRequest,
  type CompletionResult,
  type CustomProvider,
  type ModelTier,
  OcraError,
  type ReviewContext,
  type RuntimeOptions,
  type Sampling,
  type Usage,
} from "@open-cr-agent/core";
import {
  type AttemptOutcome,
  completeWithFailback,
  MAX_AGENT_STEPS,
  ModelHealth,
  parseModel,
  RESUME_MESSAGE,
  REVIEW_TOOLS,
  reviewTools,
  withFailback,
  withoutSecrets,
} from "@open-cr-agent/core/internal";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { resolveOpencodeBinary } from "./binary.js";
import { type OpencodeServer, startOpencodeServer } from "./opencode-server.js";
import { credentialValues, missingCredentials, serverEnv } from "./server-env.js";
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
// The helper answers in one step and has no tools. It still needs two:
// OpenCode appends an assistant message on an agent's last allowed step, and
// Gemini rejects a request that ends with a model turn (#66).
export const HELPER_AGENT_STEPS = 2;

// Sent once to a review agent that stopped before finishing (session-prompt.ts).
export const REVIEW_RESUME = {
  doneTool: REVIEW_TOOLS.taskDone,
  maxSteps: MAX_AGENT_STEPS,
  message: RESUME_MESSAGE,
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
  // Redacted from what a provider's error says (ADR-0020).
  secrets: readonly string[];
  root: string;
  tools: ToolServer;
  server: OpencodeServer;
  client: OpencodeClient;
  dispatcher: ReturnType<typeof createUntimedDispatcher>;
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";
  readonly sampling: AppliedSampling;
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
    this.sampling = openCodeSampling(options.sampling);
  }

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.context && this.context !== spec.context) {
      throw new OcraError("INTERNAL", "An OpenCodeRuntime instance serves a single review run");
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
            toolPrefix: `${MCP_SERVER}_`,
            resume: REVIEW_RESUME,
          },
          signal,
          onUsage,
        ),
    });
  }

  async complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const chain = this.options.models[request.tier] ?? [];
    if (chain.length === 0) throw new OcraError("CONFIG_INVALID", noModel(request.tier));

    const infra = await this.start();
    return completeWithFailback({
      tier: request.tier,
      chain,
      health: this.health,
      signal,
      attempt: (model) =>
        this.prompt(
          infra,
          {
            title: "ocra helper",
            agent: HELPER_AGENT,
            model,
            system: request.system,
            user: request.user,
            tools: this.helperTools,
            toolPrefix: `${MCP_SERVER}_`,
          },
          signal,
        ),
    });
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
  ): Promise<AttemptOutcome> {
    return promptSession(
      infra.client.session,
      input,
      `${MCP_SERVER}_${REVIEW_TOOLS.reportFinding}`,
      signal,
      onUsage ? { onUsage } : {},
    ).then((outcome) =>
      outcome.error
        ? {
            ...outcome,
            error: {
              ...outcome.error,
              message: withoutSecrets(outcome.error.message, infra.secrets),
            },
          }
        : outcome,
    );
  }

  private start(): Promise<Infra> {
    this.infra ??= this.launch();
    return this.infra;
  }

  private async launch(): Promise<Infra> {
    const custom = this.options.providers ?? {};
    const missing = missingCredentials(this.options.env, providersOf(this.options.models), custom);
    if (missing.length > 0) throw new OcraError("CONFIG_CREDENTIALS_MISSING", missing.join("; "));
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
        cwd: workspace,
        env: serverEnv(this.options.env, dirs, providersOf(this.options.models), custom),
        config: openCodeConfig(tools, this.helperTools, custom, this.options.sampling),
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
      const secrets = credentialValues(this.options.env, providersOf(this.options.models), custom);
      return { root, tools, server, client, dispatcher, onExit, secrets };
    } catch (error) {
      await Promise.allSettled([tools.close(), started?.close()]);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}

// OpenCode 1.18.32 takes a temperature per agent and sends it when the
// model's catalog entry says the model accepts one; a model declared in
// configuration is marked so (providerConfig). It has no seed setting: the
// request it builds carries temperature, topP, topK and the output limit only.
function openCodeSampling(sampling: Sampling = {}): AppliedSampling {
  return {
    ...(sampling.temperature === undefined ? {} : { temperature: sampling.temperature }),
    ...(sampling.seed === undefined ? {} : { notApplied: ["seed" as const] }),
  };
}

export function openCodeConfig(
  tools: Pick<ToolServer, "url" | "headers">,
  helperTools: Record<string, boolean>,
  custom: Readonly<Record<string, CustomProvider>> = {},
  sampling: Sampling = {},
) {
  const permission = { edit: "deny", bash: "deny", webfetch: "deny", skill: "deny" };
  const { temperature } = sampling;
  const agentSampling = temperature === undefined ? {} : { temperature };
  return {
    share: "disabled",
    autoupdate: false,
    ...(Object.keys(custom).length > 0
      ? { provider: providerConfig(custom, temperature !== undefined) }
      : {}),
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
        ...agentSampling,
      },
      [HELPER_AGENT]: {
        mode: "primary",
        prompt: HELPER_AGENT_PROMPT,
        steps: HELPER_AGENT_STEPS,
        tools: helperTools,
        permission,
        ...agentSampling,
      },
    },
  };
}

// OpenCode's form of a provider declared in configuration. OpenCode bundles
// the OpenAI-compatible client, so nothing is installed to reach it
// (docs/spikes/0002). The key stays in the environment: OpenCode reads
// {env:NAME} itself, and the configuration, which OpenCode may log, never
// holds it. Prices are per million tokens, as OpenCode's catalog has them.
// OpenCode assumes a declared model takes no temperature and drops one;
// with a temperature configured, the models are marked as taking it.
function providerConfig(custom: Readonly<Record<string, CustomProvider>>, temperature: boolean) {
  return Object.fromEntries(
    Object.entries(custom).map(([id, provider]) => [
      id,
      {
        npm: "@ai-sdk/openai-compatible",
        name: id,
        options: {
          baseURL: provider.baseUrl,
          ...(provider.apiKeyEnv ? { apiKey: `{env:${provider.apiKeyEnv}}` } : {}),
        },
        models: Object.fromEntries(
          Object.entries(provider.models).map(([model, price]) => [
            model,
            {
              name: model,
              ...(temperature ? { temperature: true } : {}),
              cost: {
                input: price.input,
                output: price.output,
                ...(price.cachedInput === undefined ? {} : { cache_read: price.cachedInput }),
              },
            },
          ]),
        ),
      },
    ]),
  );
}

function providersOf(models: RuntimeOptions["models"]): string[] {
  return Object.values(models).flatMap((chain) =>
    (chain ?? []).map((m) => parseModel(m).providerID),
  );
}

function noModel(tier: ModelTier): string {
  return `No model configured for the "${tier}" tier; set models.${tier} in .ocra/config.json or OCRA_MODEL_${tier.toUpperCase()}`;
}
