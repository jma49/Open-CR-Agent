import { z } from "zod";
import { MAX_MERGE_CHECKS, mergeCheckSchema } from "./merge-checks.js";
import {
  AGENT_ROLES,
  effortSchema as effort,
  GUIDELINE_SCOPES,
  RISK_TIERS,
  reviewDepthSchema,
  severitySchema,
} from "./vocabulary.js";

// What .ocra/config.json may say: the CLI checks every layer of settings
// against it, and ocra Cloud a file before it commits one, so both refuse
// the same files.

// As in repository.ts: the WHATWG URL of Node.js and Workers, without their types.
declare const URL: new (url: string) => { protocol: string; hostname: string };

/** The longest timeout a timer keeps (2^31 - 1 ms, about 24.8 days), in minutes. */
export const MAX_TIMEOUT_MINUTES = 35_791;
const timeoutMinutes = z.number().positive().max(MAX_TIMEOUT_MINUTES).optional();

const modelChain = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (typeof value === "string" ? [value] : value));

// Where review code is sent: over https, or plain http only to this machine.
// OpenCode replaces {env:NAME} and {file:path} anywhere in its configuration,
// so an address with braces could carry a variable or a file (the checkout's
// .git/config holds its token) to the endpoint. A failed format check lets
// later checks run unless it aborts, and new URL() throws on what it refused.
const endpoint = z
  .url({ abort: true })
  .refine((value) => {
    const url = new URL(value);
    if (url.protocol === "https:") return true;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return (
      url.protocol === "http:" &&
      (host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host))
    );
  }, "must be an https URL, or http on this machine (localhost, 127.0.0.1, ::1)")
  .refine((value) => !/[{}]/.test(value), "must not contain { or }");

// The platforms' and clouds' credentials never go to a model endpoint; the
// same prefixes are never passed to the runtime by prefix (server-env.ts).
const PLATFORM_TOKENS = /^(GITHUB_|GH_|GITLAB_|CI_|ACTIONS_|RUNNER_|AWS_|AZURE_|NPM_|SSH_|OCRA_)/;
// The MCP server a tracker's tasks are read from (ADR-0052): reached over
// the network only, so configuration never starts a process for it.
const trackerServer = z
  .object({
    url: endpoint,
    tokenEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
      .refine((name) => !PLATFORM_TOKENS.test(name), "must not name a platform or cloud credential")
      .optional(),
  })
  .strict();
const toolArguments = z.record(z.string().min(1), z.string()).optional();

const trackersSchema = z
  .object({
    jira: z
      .object({
        projects: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,9}$/, "a Jira project key")).min(1),
        server: trackerServer,
        tool: z.string().min(1),
        keyArgument: z.string().min(1),
        arguments: toolArguments,
      })
      .strict(),
    tapd: z
      .object({
        workspace: z.string().regex(/^\d{1,20}$/, "a TAPD workspace id"),
        server: trackerServer,
        tools: z
          .object({ story: z.string().min(1), bug: z.string().min(1), task: z.string().min(1) })
          .partial()
          .strict(),
        keyArgument: z.string().min(1),
        arguments: toolArguments,
      })
      .strict(),
  })
  .partial()
  .strict();
export type TrackersConfig = z.output<typeof trackersSchema>;

const MAX_PROJECT_DOC_ENTRIES = 20;
// A path inside the repository, as git names it; validated again after
// normalising when it is read.
const docPath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (path) => !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes(".."),
    "must be a path inside the repository, with / between its parts",
  );

const price = z.number().min(0).max(10_000);
// A review's instructions and tools alone take a few thousand tokens.
const MIN_CONTEXT_WINDOW = 8_000;

const providerSchema = z
  .object({
    // The protocol the endpoint speaks: OpenAI's chat completions under
    // baseUrl/chat/completions, or Anthropic's Messages under
    // baseUrl/v1/messages.
    type: z.enum(["openai-compatible", "anthropic"]),
    baseUrl: endpoint,
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name")
      .refine((name) => !PLATFORM_TOKENS.test(name), "must not name a platform or cloud credential")
      .optional(),
    // Prices in US dollars per million tokens; 0 means unpriced.
    // contextWindow: the tokens one request may hold, for a model with a
    // small window.
    models: z
      .record(
        z.string().regex(/^[\w./:@-]{1,200}$/),
        z
          .object({
            input: price,
            output: price,
            cachedInput: price.optional(),
            contextWindow: z.int().min(MIN_CONTEXT_WINDOW).max(10_000_000).optional(),
          })
          .strict(),
      )
      .refine((models) => Object.keys(models).length > 0, "must list at least one model"),
    // How an OpenAI-compatible endpoint takes a reasoning effort: "openai"
    // sends reasoning_effort (the default), "openrouter" sends
    // reasoning.effort.
    effort: z.enum(["openai", "openrouter"]).optional(),
    // How the endpoint's models call tools: "api" through the protocol's
    // tools parameter (the default), "text" as blocks in the answer, for an
    // endpoint that takes no tools.
    toolCalls: z.enum(["api", "text"]).optional(),
  })
  .strict()
  .refine((p) => p.type !== "anthropic" || p.effort === undefined, {
    path: ["effort"],
    message: "applies to an openai-compatible provider only",
  })
  .refine((p) => p.type !== "anthropic" || p.toolCalls === undefined, {
    path: ["toolCalls"],
    message: "applies to an openai-compatible provider only",
  });

// The runtimes ocra ships; a plugin may register another name, so the
// schema lists these for editors and still accepts any other string.
const BUILTIN_RUNTIMES = ["opencode", "direct"] as const;

export const configSchema = z
  .object({
    $schema: z.string().optional(),
    models: z
      .object({ top: modelChain, standard: modelChain, light: modelChain })
      .partial()
      .strict()
      .default({}),
    effort: z
      .object({ top: effort, standard: effort, light: effort })
      .partial()
      .strict()
      .default({}),
    concurrency: z.number().int().min(1).max(32).optional(),
    taskTimeoutMinutes: timeoutMinutes,
    runTimeoutMinutes: timeoutMinutes,
    verify: z.boolean().optional(),
    judge: z.boolean().optional(),
    showPreExisting: z.boolean().optional(),
    // Recall over cost (--ultra, --no-ultra); unset, the account's or off.
    ultra: z.boolean().optional(),
    // A preset of ultra, effort, reviewers and the inline policy, under what
    // the layers set themselves (--depth).
    depth: reviewDepthSchema.optional(),
    // Which findings are posted as inline comments; the rest are listed in
    // the summary and kept in the report (ADR-0076).
    minInlineSeverity: severitySchema.optional(),
    maxInlineComments: z.number().int().min(0).max(1_000).optional(),
    walkthrough: z.boolean().optional(),
    fixes: z.boolean().optional(),
    linkedTasks: z.boolean().optional(),
    // Which sections of AGENTS.md each review task is given (ADR-0059).
    guidelineScope: z.enum(GUIDELINE_SCOPES).optional(),
    trackers: trackersSchema.default({}),
    // Markdown files, or directories of them, in the repository (ADR-0052).
    projectDocs: z.array(docPath).max(MAX_PROJECT_DOC_ENTRIES).optional(),
    // Pre-merge checks in plain words, judged against the change (ADR-0054).
    mergeChecks: z
      .array(mergeCheckSchema)
      .max(MAX_MERGE_CHECKS)
      .refine((checks) => new Set(checks.map((c) => c.id)).size === checks.length, {
        error: "each check needs its own id",
      })
      .optional(),
    maxCostUsd: z.number().positive().optional(),
    maxTasks: z.number().int().min(1).max(1_000).optional(),
    // Unset: each provider's default. A seed makes sampling repeatable only
    // where the provider supports it.
    sampling: z
      .object({
        temperature: z.number().min(0).max(2),
        seed: z
          .number()
          .int()
          .min(0)
          .max(2 ** 31 - 1),
      })
      .partial()
      .strict()
      .optional(),
    github: z
      .object({ requestChanges: z.boolean(), botLogin: z.string().min(1) })
      .partial()
      .strict()
      .default({}),
    // Whether an upload to ocra Cloud names the repository besides its hash.
    cloud: z.object({ shareRepoName: z.boolean() }).partial().strict().default({}),
    // ADR-0040: whether a person merges what `ocra learn --propose` opens.
    learnings: z.object({ requireReview: z.boolean() }).partial().strict().default({}),
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    // Unset means "opencode"; loadConfig fills it in and records whether the
    // file chose, so account defaults (ADR-0025) apply only where it did not.
    runtime: z.enum(BUILTIN_RUNTIMES).or(z.string().min(1)).optional(),
    plugins: z.array(z.string().min(1)).default([]),
    reviewers: z
      .record(
        z.string(),
        z
          .object({
            enabled: z.boolean(),
            minTier: z.enum(RISK_TIERS),
            // The reviewer's own chain, for its review tasks and plan call.
            models: modelChain,
            effort,
          })
          .partial()
          .strict(),
      )
      .default({}),
    roles: z
      .partialRecord(
        z.enum(AGENT_ROLES),
        z.object({ models: modelChain, effort }).partial().strict(),
      )
      .default({}),
    pluginSettings: z.record(z.string(), z.unknown()).default({}),
    providers: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), providerSchema).default({}),
    extends: z.string().min(1).optional(),
  })
  .strict();

/** A configuration file as written, and as read with its defaults. */
export type OcraConfigInput = z.input<typeof configSchema>;
export type OcraConfig = z.output<typeof configSchema>;

export const CONFIG_SCHEMA_ID = "https://ocra.majincheng.com/schema/config.v1.json";

// JSON Schema (draft 2020-12) of .ocra/config.json, for editors: what a
// file may say, so defaults are optional and model chains take either form.
export function configJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(configSchema, { target: "draft-2020-12", io: "input" });
  const { $schema, ...rest } = generated;
  return {
    $schema,
    $id: CONFIG_SCHEMA_ID,
    title: "ocra configuration",
    description:
      "The .ocra/config.json file of a repository, or a file passed with --config. Unknown keys are rejected.",
    ...rest,
  };
}
