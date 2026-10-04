import {
  type AgentEvent,
  type AgentRuntime,
  type AgentTaskSpec,
  type AppliedSampling,
  type AppliedSettings,
  type CompletionRequest,
  type CompletionResult,
  type CustomProvider,
  type Effort,
  type ModelPrice,
  type ModelTier,
  OcraError,
  type RuntimeOptions,
  type ToolDefinition,
} from "@open-cr-agent/core";
import {
  completeWithFailback,
  MAX_AGENT_STEPS,
  ModelHealth,
  parseModel,
  proxiedFetch,
  RESUME_MESSAGE,
  reviewTools,
  withFailback,
} from "@open-cr-agent/core/internal";
import { EffortLedger } from "./effort.js";
import { runLoop } from "./loop.js";
import type { Endpoint } from "./openai.js";

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
  private readonly health = new ModelHealth();
  private readonly tools: readonly ToolDefinition[];
  private readonly fetch: typeof fetch;
  private readonly efforts: EffortLedger;

  constructor(private readonly options: DirectRuntimeOptions) {
    this.tools = [...reviewTools, ...options.tools];
    this.fetch = options.fetch ?? proxiedFetch(options.env);
    const { temperature, seed } = options.sampling ?? {};
    this.sampling = {
      ...(temperature === undefined ? {} : { temperature }),
      ...(seed === undefined ? {} : { seed }),
    };
    this.efforts = new EffortLedger(this.sampling);
  }

  appliedTo(agent: string): AppliedSettings | undefined {
    return this.efforts.appliedTo(agent);
  }

  async *runTask(spec: AgentTaskSpec, signal: AbortSignal): AsyncIterable<AgentEvent> {
    const chain = this.options.models[spec.modelTier] ?? [];
    const refused = chain.length === 0 ? noModel(spec.modelTier) : this.unreachable(chain);
    if (refused) {
      yield { type: "error", taskId: spec.taskId, error: refused.message, retryable: false };
      return;
    }
    yield* withFailback({
      taskId: spec.taskId,
      tier: spec.modelTier,
      chain,
      health: this.health,
      signal,
      attempt: (model, onUsage) =>
        runLoop({
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
        }),
    });
  }

  async complete(request: CompletionRequest, signal: AbortSignal): Promise<CompletionResult> {
    const chain = this.options.models[request.tier] ?? [];
    const refused = chain.length === 0 ? noModel(request.tier) : this.unreachable(chain);
    if (refused) throw refused;
    return completeWithFailback({
      tier: request.tier,
      chain,
      health: this.health,
      signal,
      attempt: (model) =>
        runLoop({
          ...this.target(model),
          ...this.call({ agent: request.agent ?? request.tier, effort: request.effort, model }),
          system: request.system,
          user: request.user,
          tools: [],
          context: NO_CONTEXT,
          maxSteps: 1,
          timeoutMs: request.timeoutMs,
          signal,
        }),
    });
  }

  // Why a chain cannot be served, before any request: a provider the
  // configuration does not declare, a model it gives no price, or a key
  // variable that is not set.
  private unreachable(chain: readonly string[]): OcraError | undefined {
    for (const model of chain) {
      const { providerID, modelID } = parseModel(model);
      const provider = this.options.providers?.[providerID];
      if (!provider) {
        return new OcraError(
          "CONFIG_INVALID",
          `"${model}" names no provider declared in configuration; the direct runtime reaches only declared OpenAI-compatible endpoints (use the opencode runtime for ${providerID})`,
        );
      }
      if (!provider.models[modelID]) {
        return new OcraError(
          "CONFIG_INVALID",
          `"${model}" has no price in the declaration of provider "${providerID}"`,
        );
      }
      if (provider.apiKeyEnv && !this.options.env[provider.apiKeyEnv]) {
        return new OcraError(
          "CONFIG_CREDENTIALS_MISSING",
          `No API key for provider "${providerID}": set ${provider.apiKeyEnv}`,
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

  private target(model: string): Target {
    const { providerID, modelID } = parseModel(model);
    const provider = this.options.providers?.[providerID] as CustomProvider;
    const key = provider.apiKeyEnv ? this.options.env[provider.apiKeyEnv] : undefined;
    return {
      endpoint: {
        baseUrl: provider.baseUrl,
        ...(key ? { apiKey: key } : {}),
        fetch: this.fetch,
      },
      model: modelID,
      price: provider.models[modelID] as ModelPrice,
    };
  }
}

// A helper call has no tools, so it gets a context that answers nothing.
const NO_CONTEXT = {
  readFile: async () => undefined,
  readDiff: () => undefined,
  searchCode: async () => [],
};

function noModel(tier: ModelTier): OcraError {
  return new OcraError(
    "CONFIG_INVALID",
    `No ${tier} model configured (set OCRA_MODEL_${tier.toUpperCase()} or models.${tier})`,
  );
}
