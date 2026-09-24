import type { z } from "zod";
import type { AgentRuntime, ModelTier, ReviewContext, VcsAdapter } from "../contracts.js";
import type { ReviewEvent } from "../pipeline/report.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import type { RepoRule } from "../rules/repo-rules.js";

export type Env = Readonly<Record<string, string | undefined>>;

export interface RuntimeOptions {
  models: { [Tier in ModelTier]?: string | undefined };
  tools: readonly ToolDefinition[];
  env: Env;
}

export type VcsFactory = (options: unknown) => VcsAdapter;
export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;

export interface ToolDefinition<Args = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Args>;
  execute(args: Args, context: ReviewContext): Promise<string>;
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
