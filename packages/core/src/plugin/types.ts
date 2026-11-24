import type { z } from "zod";
import type { AgentRuntime, ModelChains, Sampling, ToolDefinition } from "../contracts.js";
import type { ReviewEvent } from "../report/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { RepoRule } from "../rules/repo-rules.js";
import type { VcsAdapter } from "../vcs.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface RuntimeOptions {
  models: ModelChains;
  // Agents' own chains by agent id (ADR-0025), which their calls carry: every
  // model a call may name besides the tier chains, for a runtime that
  // prepares its providers before the first call.
  agentModels?: Readonly<Record<string, readonly string[]>>;
  tools: readonly ToolDefinition[];
  env: Env;
  // Providers declared in configuration, by id, for model chains to name.
  providers?: Readonly<Record<string, CustomProvider>>;
  // Sent with every model call the runtime can send it with; the runtime's
  // `sampling` says what it applied.
  sampling?: Sampling;
}

// A model provider declared in configuration: a self-hosted server, a
// company gateway or a model maker's own API.
export interface CustomProvider {
  // The protocol the endpoint speaks: OpenAI's chat completions (default),
  // under `baseUrl`/chat/completions, or Anthropic's Messages, under
  // `baseUrl`/v1/messages.
  api?: "openai" | "anthropic";
  baseUrl: string;
  // The environment variable that holds the key; the key itself never
  // appears in configuration.
  apiKeyEnv?: string;
  // Prices in US dollars per million tokens, by model id, so reported cost
  // and the spend limit count its use.
  models: Readonly<Record<string, ProviderModel>>;
  // How a chat completions endpoint takes a reasoning effort: OpenAI's
  // `reasoning_effort` (default), or OpenRouter's `reasoning: { effort }`.
  effort?: "openai" | "openrouter";
  // How a chat completions endpoint's models call tools: through the
  // protocol's `tools` (default), or as text in the answer, for an endpoint
  // that takes no `tools` (ADR-0070).
  toolCalls?: "api" | "text";
}

export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

// A model as a provider's declaration has it.
export interface ProviderModel extends ModelPrice {
  // Tokens one request may hold, the answer included. Declared for a model
  // with a small window, so a review is planned and stopped within it
  // (ADR-0071).
  contextWindow?: number;
}

export type VcsFactory = (options: unknown) => VcsAdapter;
export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;

export interface BootstrapContext<Settings = unknown> {
  settings: Settings;
  env: Env;
  warn(message: string): void;
}

export interface ConfigureContext<Settings = unknown> extends BootstrapContext<Settings> {
  registerVcs(name: string, factory: VcsFactory): void;
  registerRuntime(name: string, factory: RuntimeFactory): void;
  registerReviewer(reviewer: ReviewerDefinition): void;
  registerRules(rules: readonly RepoRule[]): void;
  registerTool(tool: ToolDefinition): void;
  onEvent(listener: (event: ReviewEvent) => void): void;
}

export interface PluginSummary {
  plugins: readonly string[];
  vcs: readonly string[];
  runtimes: readonly string[];
  reviewers: readonly string[];
  tools: readonly string[];
}

export interface PostConfigureContext<Settings = unknown> extends BootstrapContext<Settings> {
  registered: PluginSummary;
}

export interface OcraPlugin<Settings = unknown> {
  name: string;
  settingsSchema?: z.ZodType<Settings>;
  bootstrap?(ctx: BootstrapContext<Settings>): Promise<void>;
  configure?(ctx: ConfigureContext<Settings>): void | Promise<void>;
  postConfigure?(ctx: PostConfigureContext<Settings>): void | Promise<void>;
}
