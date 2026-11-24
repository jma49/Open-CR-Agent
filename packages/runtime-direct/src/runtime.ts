import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  type AppliedSampling,
  type AppliedSettings,
  type AttemptOutcome,
  ChainRunner,
  type CompletionRequest,
  type CompletionResult,
  type CustomProvider,
  type Effort,
  MAX_AGENT_STEPS,
  type ModelPrice,
  OcraError,
  type ProviderModel,
  parseModel,
  proxiedFetch,
  type RateLimits,
  RESUME_MESSAGE,
  type RuntimeOptions,
  readTools,
  reviewTools,
  type TaskAttempt,
  type ToolDefinition,
  type Usage,
  WRAP_UP_MESSAGE,
  WRAP_UP_STEPS,
  WRAP_UP_TOOLS,
} from "@open-cr-agent/core";
import { anthropicWire } from "./anthropic.js";
import { EffortLedger } from "./effort.js";
import { runLoop } from "./loop.js";
import { openaiWire } from "./openai.js";
import { RECORD_DIR_ENV, recordingFetch } from "./record.js";
import { SharedStarts } from "./shared-starts.js";
import type { Endpoint, Wire } from "./wire.js";

export interface DirectRuntimeOptions extends RuntimeOptions {
  // Tests point this at a server of their own; otherwise requests honor the
  // proxy variables of the given environment.
  fetch?: typeof fetch;
}

interface Target {
  wire: Wire;
  starts: SharedStarts;
  endpoint: Endpoint;
  model: string;
  price: ModelPrice;
  contextWindow?: number;
}

interface Call {
  agent: string;
  effort: Effort | undefined;
  model: string;
}

// Talks to the declared endpoints itself, in OpenAI's chat completions or
// Anthropic's Messages protocol as each declares: no OpenCode process, no
// catalog fetch, no package install, nothing on disk. A model of
// a provider that is not declared in configuration is refused, since the
// runtime knows no other address to send code to.
export class DirectRuntime implements AgentRuntime {
  readonly name = "direct";
  readonly toolsets = true;
  // The chat completions protocol takes both settings; an agent on a
  // Messages endpoint reports them as not applied.
  readonly sampling: AppliedSampling;
  private readonly chains: ChainRunner;
  private readonly tools: readonly ToolDefinition[];
  private readonly fetch: typeof fetch;
  private readonly efforts: EffortLedger;
  // Models whose endpoint refused the tools: their later calls start with
  // the tools as text instead of paying for another refusal (ADR-0070).
  private readonly toolsAsText = new Set<string>();
  private readonly starts = new SharedStarts();

  private readonly options: DirectRuntimeOptions;

  constructor(options: DirectRuntimeOptions) {
    this.options = options;
    this.tools = [...reviewTools, ...options.tools];
    this.fetch = this.recorded(options.fetch ?? proxiedFetch(options.env));
    const { temperature, seed } = options.sampling ?? {};
    this.sampling = {
      ...(temperature === undefined ? {} : { temperature }),
      ...(seed === undefined ? {} : { seed }),
    };
    this.efforts = new EffortLedger(this.sampling);
    this.chains = new ChainRunner(options.models, {
      refuse: (chain) => this.unreachable(chain),
      task: (model, spec, signal, onUsage, limits) =>
        this.attemptTask(model, spec, signal, onUsage, limits),
      complete: (model, request, signal) => this.attemptCompletion(model, request, signal),
    });
  }

  // Every exchange goes to the recording directory when one is set, with the
  // keys of all declared providers taken out as they are at each write: the
  // environment may be live, renewing a key while the run lasts. The first
  // recording that fails is said once on stderr, which a review's output
  // (stdout) does not share.
  private recorded(base: typeof fetch): typeof fetch {
    const dir = this.options.env[RECORD_DIR_ENV];
    if (!dir) return base;
    const { env, providers } = this.options;
    const keys = () =>
      Object.values(providers ?? {}).flatMap((p) => {
        const key = p.apiKeyEnv ? env[p.apiKeyEnv] : undefined;
        return key ? [key] : [];
      });
    let warned = false;
    return recordingFetch(base, dir, keys, (message) => {
      if (warned) return;
      warned = true;
      process.stderr.write(`ocra: ${message}; the review goes on without recording it\n`);
    });
  }

  appliedTo(agent: string): AppliedSettings | undefined {
    return this.efforts.appliedTo(agent);
  }

  runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    return this.chains.runTask(spec, signal);
  }

  complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    return this.chains.complete(request, signal);
  }

  private attemptTask(
    model: string,
    spec: AgentTaskSpec,
    signal: AbortSignal,
    onUsage: (spent: Usage) => void,
    limits: RateLimits,
  ): Promise<TaskAttempt> {
    return runLoop({
      ...this.target(model),
      ...this.call({ agent: spec.reviewer, effort: spec.effort, model }),
      system: spec.systemPrompt,
      user: spec.userPrompt,
      ...(spec.sharedPrefixes ? { shared: spec.sharedPrefixes } : {}),
      tools: spec.toolset ? [...readTools, ...spec.toolset.tools] : this.tools,
      context: spec.context,
      maxSteps: MAX_AGENT_STEPS,
      resume: spec.toolset?.resume ?? RESUME_MESSAGE,
      wrapUp: {
        message: spec.toolset?.wrapUp.message ?? WRAP_UP_MESSAGE,
        tools: spec.toolset?.wrapUp.tools ?? WRAP_UP_TOOLS,
        steps: WRAP_UP_STEPS,
      },
      timeoutMs: spec.timeoutMs,
      signal,
      onUsage,
      limits,
    });
  }

  private attemptCompletion(
    model: string,
    request: CompletionRequest,
    signal: AbortSignal,
  ): Promise<AttemptOutcome> {
    return runLoop({
      ...this.target(model),
      ...this.call({ agent: request.agent ?? request.tier, effort: request.effort, model }),
      system: request.system,
      user: request.user,
      ...(request.sharedPrefixes ? { shared: request.sharedPrefixes } : {}),
      // As the task that follows opens, so that it reads what this stores.
      tools: request.sharedPrefixes ? this.tools : [],
      context: NO_CONTEXT,
      maxSteps: 1,
      oneRequest: true,
      timeoutMs: request.timeoutMs,
      signal,
    });
  }

  // Why a chain cannot be served, before any request: a provider the
  // configuration does not declare, a model it gives no price, or a key
  // variable that is not set.
  private unreachable(chain: readonly string[]): OcraError | undefined {
    for (const model of chain) {
      const declared = this.declared(model);
      if (declared instanceof OcraError) return declared;
      const { apiKeyEnv } = declared.provider;
      if (apiKeyEnv && !this.options.env[apiKeyEnv]) {
        return new OcraError(
          "CONFIG_CREDENTIALS_MISSING",
          `No API key for provider "${parseModel(model).providerID}": set ${apiKeyEnv}`,
        );
      }
    }
    return undefined;
  }

  // What one attempt sends besides the conversation, and where a refused
  // effort or refused tools are recorded.
  private call({ agent, effort, model }: Call) {
    const { providerID } = parseModel(model);
    const provider = this.options.providers?.[providerID];
    const takesSampling = provider?.api !== "anthropic";
    return {
      settings: this.efforts.params(agent, effort, model, takesSampling),
      onEffortRefused: () => this.efforts.refuse(agent, model),
      textTools: provider?.toolCalls === "text" || this.toolsAsText.has(model),
      onToolsRefused: () => void this.toolsAsText.add(model),
    };
  }

  // A model's provider and price, from the configuration's declaration.
  private declared(
    model: string,
  ): { provider: CustomProvider; modelID: string; price: ProviderModel } | OcraError {
    const { providerID, modelID } = parseModel(model);
    const provider = this.options.providers?.[providerID];
    if (!provider) {
      return new OcraError(
        "CONFIG_INVALID",
        `"${model}" names no provider declared in configuration; the direct runtime reaches only declared endpoints (use the opencode runtime for ${providerID})`,
      );
    }
    const price = provider.models[modelID];
    if (!price) {
      return new OcraError(
        "CONFIG_INVALID",
        `"${model}" has no price in the declaration of provider "${providerID}"`,
      );
    }
    return { provider, modelID, price };
  }

  // Only for a model unreachable() let through, so declared() cannot fail.
  private target(model: string): Target {
    const declared = this.declared(model);
    if (declared instanceof OcraError) throw declared;
    const { provider, modelID, price } = declared;
    const key = provider.apiKeyEnv ? this.options.env[provider.apiKeyEnv] : undefined;
    return {
      wire: provider.api === "anthropic" ? anthropicWire : openaiWire(provider.effort),
      starts: this.starts,
      endpoint: {
        baseUrl: provider.baseUrl,
        ...(key ? { apiKey: key } : {}),
        fetch: this.fetch,
      },
      model: modelID,
      price,
      ...(price.contextWindow === undefined ? {} : { contextWindow: price.contextWindow }),
    };
  }
}

// A helper call has no tools, so it gets a context that answers nothing.
const NO_CONTEXT = {
  readFile: async () => undefined,
  readDiff: () => undefined,
  searchCode: async () => [],
};
