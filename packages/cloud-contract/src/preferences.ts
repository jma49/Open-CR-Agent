import { z } from "zod";
import { MAX_CHAIN } from "./limits.js";
import { CLOUD_PREFIX, isCloudModel } from "./providers.js";
import {
  AGENT_ROLES,
  agentRoleSchema,
  effortSchema,
  REVIEWER_ID,
  runtimeSchema,
} from "./vocabulary.js";

// The account's settings (ADR-0025, ADR-0027): what the web saves with
// PUT /api/preferences and a CLI layers under a repository's
// configuration. Never providers, extends or botLogin: those can move code
// or keys, and only a configuration file may set them.
//
// A value of null, "" or [] sets nothing. ocra Cloud also refuses a model
// whose provider has no OpenAI-compatible chat route, which it alone knows.

// Drops the keys that set nothing.
function present<T extends Record<string, unknown>>(
  value: T,
): { [K in keyof T]?: NonNullable<T[K]> } {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, v]) =>
        v !== undefined &&
        v !== null &&
        !(Array.isArray(v) && v.length === 0) &&
        !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0),
    ),
  ) as { [K in keyof T]?: NonNullable<T[K]> };
}

export const cloudModelSchema = z
  .string()
  .refine(isCloudModel, `a model is ${CLOUD_PREFIX}<provider>/<model>`);

/** A failback chain: up to MAX_CHAIN models, or one model on its own. */
export const modelChainSchema = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : [v]).filter((m) => m !== ""))
  .pipe(z.array(cloudModelSchema).max(MAX_CHAIN));

const chain = modelChainSchema.nullish();
const effort = z
  .union([effortSchema, z.literal(""), z.null()])
  .optional()
  .transform((v) => v || undefined);

export const modelChainsSchema = z
  .object({ top: chain, standard: chain, light: chain })
  .transform(present);
export type ModelChains = z.output<typeof modelChainsSchema>;

const reviewerSchema = z
  .object({ enabled: z.boolean().optional(), models: chain, effort })
  .nullish()
  .transform((v) => present(v ?? {}));
const roleSchema = z
  .object({ models: chain, effort })
  .nullish()
  .transform((v) => present(v ?? {}));

export const agentPrefsSchema = z
  .object({
    effort: z
      .object({ top: effort, standard: effort, light: effort })
      .nullish()
      .transform((v) => present(v ?? {})),
    reviewers: z
      .record(
        z
          .string()
          .regex(REVIEWER_ID)
          .refine(
            (id) => !(AGENT_ROLES as readonly string[]).includes(id),
            "a role, not a reviewer",
          ),
        reviewerSchema,
      )
      .refine((r) => Object.keys(r).length <= 30, "at most 30 reviewers")
      .nullish()
      .transform((v) => present(v ?? {})),
    roles: z
      .partialRecord(agentRoleSchema, roleSchema)
      .nullish()
      .transform((v) => present(v ?? {})),
  })
  .transform(present);
export type AgentPrefs = z.output<typeof agentPrefsSchema>;

const GLOB = /^[^\n\r\0]{1,300}$/;
// An npm package name, scoped or not; versions are pinned on each machine.
const PACKAGE = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const MAX_PLUGIN_SETTINGS_JSON = 16_384;

const globs = z.array(z.string().regex(GLOB)).max(100);
const minutes = z.number().gt(0).max(600);

const ruleSchema = z.strictObject({
  path: z.union([z.string().regex(GLOB), z.array(z.string().regex(GLOB)).min(1).max(20)]),
  rule: z
    .string()
    .max(2_000)
    .transform((r) => r.trim())
    .pipe(z.string().min(1)),
});

/** The review's data settings an account may hold, with the configuration file's bounds. */
export const reviewSettingsSchema = z
  .strictObject({
    ultra: z.boolean().nullish(),
    concurrency: z.number().int().min(1).max(32).nullish(),
    taskTimeoutMinutes: minutes.nullish(),
    runTimeoutMinutes: minutes.nullish(),
    maxCostUsd: z.number().gt(0).max(1000).nullish(),
    maxTasks: z.number().int().min(1).max(1000).nullish(),
    verify: z.boolean().nullish(),
    judge: z.boolean().nullish(),
    sampling: z
      .strictObject({
        temperature: z.number().min(0).max(2).optional(),
        seed: z
          .number()
          .int()
          .min(0)
          .max(2 ** 31 - 1)
          .optional(),
      })
      .nullish()
      .transform((v) => (v ? present(v) : v)),
    include: globs.nullish(),
    exclude: globs.nullish(),
    rules: z.array(ruleSchema).max(50).nullish(),
    plugins: z
      .array(z.string().max(214).regex(PACKAGE))
      .max(20)
      .nullish()
      .transform((v) => (v ? [...new Set(v)] : v)),
    // Only for plugins the account lists (ADR-0027); a repository plugin's
    // settings come from the repository alone.
    pluginSettings: z
      .record(z.string(), z.unknown())
      .refine(
        (s) => JSON.stringify(s).length <= MAX_PLUGIN_SETTINGS_JSON,
        `at most ${MAX_PLUGIN_SETTINGS_JSON} characters of JSON`,
      )
      .nullish(),
  })
  .superRefine((s, ctx) => {
    const listed = new Set(s.plugins ?? []);
    for (const name of Object.keys(s.pluginSettings ?? {})) {
      if (!listed.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["pluginSettings", name],
          message: "settings for a plugin the account does not list",
        });
      }
    }
  })
  .transform(present);
export type ReviewSettings = z.output<typeof reviewSettingsSchema>;

/**
 * PUT /api/preferences. A part the body leaves out keeps its saved value;
 * null clears it. `baseVersion` is the version the web's draft started
 * from: a save from a stale tab answers `stale`. A body without it (the
 * CLI) saves.
 */
export const preferencesUpdateSchema = z.object({
  runtime: runtimeSchema.nullish(),
  models: modelChainsSchema.nullish(),
  agents: agentPrefsSchema.nullish(),
  settings: reviewSettingsSchema.nullish(),
  baseVersion: z.string().nullish(),
});
export type PreferencesUpdate = z.input<typeof preferencesUpdateSchema>;

/**
 * GET /api/preferences: `runtime`, `models`, `agents`, `settings`,
 * `updatedAt` and `version` (null before the first save). A client reads
 * it key by key, so a key it does not know never breaks it.
 */
export const preferencesAnswerSchema = z.record(z.string(), z.unknown());
