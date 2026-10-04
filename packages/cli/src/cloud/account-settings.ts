import { CLOUD_PREFIX, isCloudModel } from "@open-cr-agent/cloud-contract";
import { repoRuleSchema } from "@open-cr-agent/core/internal";
import { z } from "zod";
import { configSchema } from "../config/schema.js";

// What ocra Cloud's GET /api/preferences may set (ADR-0025, ADR-0027),
// checked key by key with the configuration file's own schema: a key that
// does not match is refused alone, and a key this CLI does not know is
// ignored, so a newer server never breaks an older CLI.

// Keys that can move code or keys, or decide whose comments are trusted:
// only a configuration file may set them, whatever the server sends.
const FORBIDDEN = new Set(["providers", "extends", "github", "botLogin", "$schema"]);

// The account's rules are bounded (ADR-0027); the repository's are its own.
const accountRules = z
  .array(repoRuleSchema.extend({ rule: z.string().min(1).max(2_000) }).strict())
  .max(50);

// Account models go through the gateway with the account's stored keys
// (ADR-0027): a chain naming any other provider could send the code where
// this machine's own keys reach. Provider names and model ids are checked
// against what ocra Cloud may name before they reach the runtime.
const cloudModel = (chain: readonly string[]) => chain.every(isCloudModel);

const shape = configSchema.shape;
const SETTINGS = {
  concurrency: shape.concurrency,
  taskTimeoutMinutes: shape.taskTimeoutMinutes,
  runTimeoutMinutes: shape.runTimeoutMinutes,
  maxCostUsd: shape.maxCostUsd,
  maxTasks: shape.maxTasks,
  verify: shape.verify,
  judge: shape.judge,
  sampling: shape.sampling,
  include: shape.include,
  exclude: shape.exclude,
  rules: accountRules,
  // A flag, not a configuration key: the account's default for --ultra,
  // which the review command applies when the command line leaves it out.
  ultra: z.boolean(),
} as const;

const AGENTS = {
  effort: shape.effort,
  reviewers: shape.reviewers.refine(
    (reviewers) => Object.values(reviewers).every((r) => !r.models || cloudModel(r.models)),
    `models must be ${CLOUD_PREFIX}<provider>/<model>`,
  ),
  roles: shape.roles.refine(
    (roles) => Object.values(roles).every((r) => !r?.models || cloudModel(r.models)),
    `models must be ${CLOUD_PREFIX}<provider>/<model>`,
  ),
} as const;

const TOP = {
  models: shape.models.refine(
    (models) => Object.values(models).every((chain) => !chain || cloudModel(chain)),
    `models must be ${CLOUD_PREFIX}<provider>/<model>`,
  ),
  // A plugin runtime would load code; the account names a built-in one.
  runtime: z.enum(["opencode", "direct"]),
} as const;

type Parsed<T extends Record<string, z.ZodType>> = { [K in keyof T]?: z.output<T[K]> };

export type AccountSettings = Parsed<typeof TOP> &
  Parsed<typeof AGENTS> &
  Parsed<typeof SETTINGS> & {
    // The saved version the server answered with; null before the first save.
    version: string | null;
  };

const IGNORED_TOP = new Set(["agents", "settings", "updatedAt", "version"]);

/** The account's settings, and warnings naming what was refused or ignored. */
export function parseAccountSettings(data: unknown): {
  settings: AccountSettings;
  warnings: string[];
} {
  const body = record(data);
  const settings: AccountSettings = {
    version: typeof body.version === "string" ? body.version : null,
  };
  const refused: string[] = [];
  const unknown: string[] = [];
  const forbidden: string[] = [];
  const pick = <T extends Record<string, z.ZodType>>(
    source: Record<string, unknown>,
    schemas: T,
    prefix: string,
    known: ReadonlySet<string> = new Set(),
  ) => {
    for (const [key, value] of Object.entries(source)) {
      if (isEmpty(value) || known.has(key)) continue;
      const name = `${prefix}${key}`;
      if (FORBIDDEN.has(key)) {
        forbidden.push(name);
        continue;
      }
      if (!Object.hasOwn(schemas, key)) {
        unknown.push(name);
        continue;
      }
      const parsed = (schemas[key] as z.ZodType).safeParse(value);
      if (parsed.success) Object.assign(settings, { [key]: parsed.data });
      else refused.push(`${name} (${z.prettifyError(parsed.error).replaceAll("\n", " ")})`);
    }
  };
  pick(body, TOP, "", IGNORED_TOP);
  pick(record(body.agents), AGENTS, "agents.");
  // Plugins and their settings are read by account-plugins.ts (ADR-0027, 3).
  pick(record(body.settings), SETTINGS, "settings.", new Set(["plugins", "pluginSettings"]));

  const warnings: string[] = [];
  if (refused.length > 0) {
    warnings.push(
      `ignoring ocra Cloud settings that do not match this version of ocra: ${refused.join("; ")}`,
    );
  }
  if (forbidden.length > 0) {
    warnings.push(
      `ignoring ${forbidden.join(", ")} from ocra Cloud: only a configuration file may set ${forbidden.length > 1 ? "them" : "it"}`,
    );
  }
  if (unknown.length > 0) {
    warnings.push(
      `ignoring ocra Cloud settings this version of ocra does not know: ${unknown.join(", ")}`,
    );
  }
  return { settings, warnings };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// The server may send a key it has no value for; that sets nothing.
function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && Object.keys(value).length === 0;
}
