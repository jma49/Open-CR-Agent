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
  parseModel,
  proxiedFetch,
  RESUME_MESSAGE,
  type RuntimeOptions,
  reviewTools,
  type ToolDefinition,
  type Usage,
} from "@open-cr-agent/core";
import { EffortLedger } from "./effort.js";
import { runLoop } from "./loop.js";
import type { Endpoint } from "./openai.js";
import { RECORD_DIR_ENV, recordingFetch } from "./record.js";

export interface DirectRuntimeOptions extends RuntimeOptions {
  // Tests point this at a server of their own; otherwise requests honor the
  // proxy variables of the given environment.
  fetch?: typeof fetch;
}

interface Target {
  endpoint: Endpoint;
  model: string;
  price: ModelPrice;
}

interface Call {
  agent: string;
  effort: Effort | undefined;
  model: string;
}

// Talks to the declared OpenAI-compatible endpoints itself: no OpenCode
// process, no catalog fetch, no package install, nothing on disk. A model of
// a provider that is not declared in configuration is refused, since the
// runtime knows no other address to send code to.
export class DirectRuntime implements AgentRuntime {
  readonly name = "direct";
  // The chat completions protocol takes both settings.
  readonly sampling: AppliedSampling;
  private readonly chains: ChainRunner;
  private readonly tools: readonly ToolDefinition[];
  private readonly fetch: typeof fetch;
  private readonly efforts: EffortLedger;

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
      task: (model, spec, signal, onUsage) => this.attemptTask(model, spec, signal, onUsage),
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
  ): Promise<AttemptOutcome> {
    return runLoop({
      ...this.target(model),
      ...this.call({ agent: spec.reviewer, effort: spec.effort, model }),
      system: spec.systemPrompt,
      user: spec.userPrompt,
      tools: this.tools,
      context: spec.context,
      maxSteps: MAX_AGENT_STEPS,
      resume: RESUME_MESSAGE,
      timeoutMs: spec.timeoutMs,
      signal,
      onUsage,
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
      tools: [],
      context: NO_CONTEXT,
      maxSteps: 1,
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
  // effort is recorded.
  private call({ agent, effort, model }: Call) {
    const { providerID } = parseModel(model);
    const style = this.options.providers?.[providerID]?.effort;
    return {
      params: this.efforts.params(agent, effort, model, style),
      onEffortRefused: () => this.efforts.refuse(agent, model),
    };
  }

  // A model's provider and price, from the configuration's declaration.
  private declared(
    model: string,
  ): { provider: CustomProvider; modelID: string; price: ModelPrice } | OcraError {
    const { providerID, modelID } = parseModel(model);
    const provider = this.options.providers?.[providerID];
    if (!provider) {
      return new OcraError(
        "CONFIG_INVALID",
        `"${model}" names no provider declared in configuration; the direct runtime reaches only declared OpenAI-compatible endpoints (use the opencode runtime for ${providerID})`,
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
      endpoint: {
        baseUrl: provider.baseUrl,
        ...(key ? { apiKey: key } : {}),
        fetch: this.fetch,
      },
      model: modelID,
      price,
    };
  }
}

// A helper call has no tools, so it gets a context that answers nothing.
const NO_CONTEXT = {
  readFile: async () => undefined,
  readDiff: () => undefined,
  searchCode: async () => [],
};
