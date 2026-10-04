import type { z } from "zod";
import type { AgentRuntime, ModelTier, ReviewContext, Sampling, VcsAdapter } from "../contracts.js";
import type { ReviewEvent } from "../pipeline/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { RepoRule } from "../rules/repo-rules.js";

export type Env = Readonly<Record<string, string | undefined>>;

export type ModelChains = { [Tier in ModelTier]?: readonly string[] };

export interface RuntimeOptions {
  models: ModelChains;
  tools: readonly ToolDefinition[];
  env: Env;
  // Providers declared in configuration, by id, for model chains to name.
  providers?: Readonly<Record<string, CustomProvider>>;
  // Sent with every model call the runtime can send it with; the runtime's
  // `sampling` says what it applied.
  sampling?: Sampling;
}

// A model provider reached through an OpenAI-compatible API: a self-hosted
// server or a company gateway.
export interface CustomProvider {
  baseUrl: string;
  // The environment variable that holds the key; the key itself never
  // appears in configuration.
  apiKeyEnv?: string;
  // Prices in US dollars per million tokens, by model id, so reported cost
  // and the spend limit count its use.
  models: Readonly<Record<string, ModelPrice>>;
  // How the endpoint takes a reasoning effort: OpenAI's `reasoning_effort`
  // (default), or OpenRouter's `reasoning: { effort }`.
  effort?: "openai" | "openrouter";
}

export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
}

export type VcsFactory = (options: unknown) => VcsAdapter;
export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  inputSchema: z.ZodObject<Shape>;
  execute(args: z.infer<z.ZodObject<Shape>>, context: ReviewContext): Promise<string>;
}

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
