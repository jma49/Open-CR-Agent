import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  type AppliedSampling,
  type AppliedSettings,
  type CompletionRequest,
  type CompletionResult,
  type Effort,
  type ModelTier,
  OcraError,
  type ReviewContext,
  type RuntimeOptions,
  type Usage,
} from "@open-cr-agent/core";
import {
  type AttemptOutcome,
  callChain,
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
import { AppliedEfforts, type EffortRoutes } from "./effort.js";
import { setUpEfforts } from "./effort-setup.js";
import {
  DISABLED_BUILTINS,
  HELPER_AGENT,
  MCP_SERVER,
  openCodeConfig,
  openCodeSampling,
  REVIEW_AGENT,
  WITHOUT_SAMPLING,
} from "./opencode-config.js";
import { type OpencodeServer, startOpencodeServer } from "./opencode-server.js";
import { credentialValues, missingCredentials, serverEnv } from "./server-env.js";
import { type PromptInput, promptSession } from "./session-prompt.js";
import { startToolServer, type ToolServer } from "./tool-server.js";
import { createUntimedDispatcher, untimedFetch } from "./transport.js";

// Sent once to a review agent that stopped before finishing (session-prompt.ts).
export const REVIEW_RESUME = {
  doneTool: REVIEW_TOOLS.taskDone,
  maxSteps: MAX_AGENT_STEPS,
  message: RESUME_MESSAGE,
};

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
  efforts: EffortRoutes;
  dispatcher: ReturnType<typeof createUntimedDispatcher>;
}

export class OpenCodeRuntime implements AgentRuntime {
  readonly name = "opencode";
  readonly sampling: AppliedSampling;
  private infra: Promise<Infra> | undefined;
  private context: ReviewContext | undefined;
  private readonly health = new ModelHealth();
  private readonly helperTools: Record<string, boolean>;
  private readonly applied: AppliedEfforts;

  constructor(private readonly options: OpenCodeRuntimeOptions) {
    const mcpTools = [...reviewTools, ...options.tools].map((t) => [
      `${MCP_SERVER}_${t.name}`,
      false,
    ]);
    this.helperTools = { ...DISABLED_BUILTINS, ...Object.fromEntries(mcpTools) };
    this.sampling = openCodeSampling(options.sampling);
    this.applied = new AppliedEfforts(options.sampling);
  }

  appliedTo(agent: string): AppliedSettings | undefined {
    return this.applied.appliedTo(agent);
  }

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    if (this.context && this.context !== spec.context) {
      throw new OcraError("INTERNAL", "An OpenCodeRuntime instance serves a single review run");
    }
    this.context = spec.context;

    const chain = callChain(this.options.models, spec.modelTier, spec.models);
    const refused = chain.length === 0 ? noModel(spec.modelTier) : this.unprepared(spec.models);
    if (refused) {
      yield { type: "error", taskId: spec.taskId, retryable: false, error: refused };
      return;
    }

    const infra = await this.start();
    yield* withFailback({
      taskId: spec.taskId,
      tier: spec.modelTier,
      ...(spec.models?.length ? { agent: spec.reviewer } : {}),
      chain,
      health: this.health,
      signal,
      attempt: (model, onUsage) =>
        this.prompt(
          infra,
          {
            title: `ocra ${spec.taskId}`,
            ...this.effortCall(infra, REVIEW_AGENT, spec.reviewer, spec.effort, model),
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
    const chain = callChain(this.options.models, request.tier, request.models);
    const refused = chain.length === 0 ? noModel(request.tier) : this.unprepared(request.models);
    if (refused) throw new OcraError("CONFIG_INVALID", refused);

    const infra = await this.start();
    return completeWithFailback({
      tier: request.tier,
      ...(request.models?.length ? { agent: request.agent ?? request.tier } : {}),
      chain,
      health: this.health,
      signal,
      attempt: (model) =>
        this.prompt(
          infra,
          {
            title: "ocra helper",
            ...this.effortCall(
              infra,
              HELPER_AGENT,
              request.agent ?? request.tier,
              request.effort,
              model,
            ),
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

  // The OpenCode agent and variant one attempt runs with, recorded for the
  // agent's provenance.
  private effortCall(
    infra: Infra,
    base: string,
    agent: string,
    effort: Effort | undefined,
    model: string,
  ): { agent: string; variant?: string } {
    if (effort === undefined) return { agent: base };
    const route = infra.efforts.route(model, effort);
    const keepsSampling = this.applied.record(agent, effort, model, route !== undefined);
    return {
      agent:
        keepsSampling || this.options.sampling?.temperature === undefined
          ? base
          : `${base}${WITHOUT_SAMPLING}`,
      ...(route?.variant ? { variant: route.variant } : {}),
    };
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

  // The server holds the credentials of the providers it started with; an
  // agent's own chain naming another would fail at OpenCode as "model not
  // found". The tier chains are always among them.
  private unprepared(own: readonly string[] | undefined): string | undefined {
    if (!own?.length) return undefined;
    const prepared = new Set(providersOf(this.options));
    const model = own.find((m) => !prepared.has(parseModel(m).providerID));
    return model === undefined
      ? undefined
      : `"${model}" is not among the models the runtime was started with (RuntimeOptions.models or agentModels)`;
  }

  private start(): Promise<Infra> {
    this.infra ??= this.launch();
    return this.infra;
  }

  private async launch(): Promise<Infra> {
    const custom = this.options.providers ?? {};
    const missing = missingCredentials(this.options.env, providersOf(this.options), custom);
    if (missing.length > 0) throw new OcraError("CONFIG_CREDENTIALS_MISSING", missing.join("; "));
    const root = await mkdtemp(join(tmpdir(), "ocra-opencode-"));
    const dirs = {
      config: join(root, "config"),
      data: join(root, "data"),
      state: join(root, "state"),
    };
    const workspace = join(root, "workspace");
    const probe = join(root, "probe");
    await Promise.all(
      [...Object.values(dirs), workspace, probe].map((d) => mkdir(d, { recursive: true })),
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
        env: serverEnv(this.options.env, dirs, providersOf(this.options), custom),
        config: openCodeConfig(tools, this.helperTools, custom, this.options.sampling),
      });
      started = server;
      const dispatcher = createUntimedDispatcher();
      const clientFor = (directory: string) =>
        createOpencodeClient({
          baseUrl: server.url,
          directory,
          headers: { Authorization: server.authorization },
          fetch: untimedFetch(dispatcher),
        });
      const client = clientFor(workspace);
      // A second Ctrl-C exits at once, before dispose() can run: stop
      // OpenCode and remove its directory synchronously on the way out.
      const onExit = () => {
        server.killNow();
        rmSync(root, { recursive: true, force: true });
      };
      process.on("exit", onExit);
      const efforts = await setUpEfforts({
        models: chainModels(this.options),
        custom,
        probe: clientFor(probe).config,
        workspace: client.config,
        file: join(dirs.config, "opencode.json"),
      });
      const secrets = credentialValues(this.options.env, providersOf(this.options), custom);
      return { root, tools, server, client, efforts, dispatcher, onExit, secrets };
    } catch (error) {
      await Promise.allSettled([tools.close(), started?.close()]);
      await rm(root, { recursive: true, force: true });
      throw error;
    }
  }
}

// Every model a call may run on: the tiers' chains and the agents' own
// (ADR-0025).
function chainModels(options: Pick<RuntimeOptions, "models" | "agentModels">): string[] {
  return [...Object.values(options.models), ...Object.values(options.agentModels ?? {})].flatMap(
    (chain) => [...(chain ?? [])],
  );
}

// The providers of those models, so each gets its credentials like a tier's.
export function providersOf(options: Pick<RuntimeOptions, "models" | "agentModels">): string[] {
  return chainModels(options).map((m) => parseModel(m).providerID);
}

function noModel(tier: ModelTier): string {
  return `No model configured for the "${tier}" tier; set models.${tier} in .ocra/config.json or OCRA_MODEL_${tier.toUpperCase()}`;
}
