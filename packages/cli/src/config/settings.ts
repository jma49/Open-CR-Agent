import { isDeepStrictEqual } from "node:util";
import { MODEL_TIERS, OcraError, type SourcedRule } from "@open-cr-agent/core";
import { z } from "zod";
import { configSchema } from "./schema.js";

// A review's settings come in layers: a shared configuration (extends), the
// repository's file or the user's own (--config), OCRA_* variables, the
// ocra Cloud account's settings under them all (ADR-0027), and the command
// line. One merge applies them and records, per setting, the layers its
// value came from, so what --plan reports is what was applied.

type FileSettings = z.output<typeof configSchema>;

export type Settings = FileSettings & {
  // A shared configuration's rules, then the account's.
  rules: SourcedRule[];
  // Recall over cost (--ultra); the account may turn it on by default.
  ultra: boolean;
};

export type SettingSource = "shared" | "file" | "env" | "account" | "flag";

export type LayerSettings = { [K in keyof Settings]?: Settings[K] };

export interface SettingsLayer {
  source: SettingSource;
  settings: LayerSettings;
  // Under the layers before it: it sets only what they left unset, and
  // adds to a list only what is not in it yet.
  under?: boolean;
}

// The sources of each setting, by name: `maxTasks`, and `models.top` or
// `reviewers.security` for one entry of a map. A setting no layer set is
// absent: ocra's default.
export type SettingSources = Record<string, SettingSource[]>;

type Merge =
  // The last layer's value, whole.
  | "replace"
  // Each entry of a map on its own, the last layer's whole.
  | "entries"
  // Each layer's values after the ones before.
  | "concat";

// How --plan lists a setting: always (as ocra's default when no layer set
// it), or only once a layer set it; a map's entries one by one, the given
// ones always, others once set.
interface Listed {
  list: "always" | "set";
  entries?: readonly string[];
  show?: (value: never) => unknown;
}

const ALL = ["shared", "file", "env", "account"] as const;
const NOT_ENV = ["shared", "file", "account"] as const;
const ALWAYS: Listed = { list: "always" };

// How each setting merges, which layers may set it, and how --plan lists
// it, in --plan's order. A shared configuration is fetched from outside the
// repository, so it never names plugins or a runtime; the account never
// moves code or keys (providers, extends) or decides whose comments are
// trusted (github). The layers' parsers refuse these with a warning; here
// they are a broken invariant.
const MERGE: {
  readonly [K in keyof Settings]-?: {
    merge: Merge;
    from: readonly SettingSource[];
    plan?: Listed;
  };
} = {
  runtime: { merge: "replace", from: ["file", "account"], plan: ALWAYS },
  models: { merge: "entries", from: ALL, plan: { list: "always", entries: MODEL_TIERS } },
  effort: { merge: "entries", from: ALL, plan: { list: "always", entries: MODEL_TIERS } },
  reviewers: { merge: "entries", from: NOT_ENV, plan: { list: "set" } },
  roles: { merge: "entries", from: NOT_ENV, plan: { list: "set" } },
  concurrency: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  taskTimeoutMinutes: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  runTimeoutMinutes: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  maxCostUsd: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  maxTasks: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  verify: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  judge: { merge: "replace", from: NOT_ENV, plan: ALWAYS },
  sampling: { merge: "replace", from: ["file", "account"], plan: ALWAYS },
  include: { merge: "concat", from: NOT_ENV, plan: ALWAYS },
  exclude: { merge: "concat", from: NOT_ENV, plan: ALWAYS },
  rules: {
    merge: "concat",
    from: ["shared", "account"],
    // Where each rule applies and whose it is; the rule's text can be long.
    plan: {
      list: "always",
      show: (rules: SourcedRule[]) => rules.map(({ path, source }) => ({ path, source })),
    },
  },
  ultra: { merge: "replace", from: ["account", "flag"], plan: { list: "set" } },
  $schema: { merge: "replace", from: ["shared", "file"] },
  github: { merge: "entries", from: ["shared", "file"] },
  plugins: { merge: "replace", from: ["file"] },
  pluginSettings: { merge: "replace", from: ["file"] },
  providers: { merge: "entries", from: ["shared", "file"] },
  extends: { merge: "replace", from: ["file"] },
};

// The configuration file's schema without its defaults, so a layer holds
// only what it sets; unknown keys are refused as in the file.
export const layerSchema = z
  .object(
    Object.fromEntries(
      Object.entries(configSchema.shape).map(([key, schema]) => [
        key,
        (schema instanceof z.ZodDefault ? schema.unwrap() : schema).optional(),
      ]),
    ),
  )
  .strict() as unknown as z.ZodType<Omit<LayerSettings, "rules" | "ultra">>;

/** The layers, earliest first, over ocra's defaults, and where each setting came from. */
export function resolveSettings(layers: readonly SettingsLayer[]): {
  settings: Settings;
  sources: SettingSources;
} {
  const merged: Record<string, unknown> = { ...configSchema.parse({}), rules: [], ultra: false };
  const sources: SettingSources = {};
  const record = (name: string, source: SettingSource) => {
    const from = sources[name] ?? [];
    if (!from.includes(source)) sources[name] = [...from, source];
  };
  for (const { source, settings, under = false } of layers) {
    for (const [key, value] of Object.entries(settings)) {
      if (value === undefined) continue;
      const rule = MERGE[key as keyof Settings];
      if (!rule.from.includes(source)) {
        throw new OcraError("INTERNAL", `the ${source} settings may not set ${key}`);
      }
      if (rule.merge === "replace") {
        if (under && sources[key]) continue;
        merged[key] = value;
        sources[key] = [source];
      } else if (rule.merge === "entries") {
        const entries = { ...(merged[key] as Record<string, unknown>) };
        for (const [entry, setting] of Object.entries(value as Record<string, unknown>)) {
          const name = `${key}.${entry}`;
          if (setting === undefined || (under && sources[name])) continue;
          entries[entry] = setting;
          sources[name] = [source];
        }
        merged[key] = entries;
      } else {
        const current = merged[key] as unknown[];
        const added = under
          ? (value as unknown[]).filter((v) => !current.some((c) => isDeepStrictEqual(c, v)))
          : (value as unknown[]);
        if (added.length === 0) continue;
        merged[key] = [...current, ...added];
        record(key, source);
      }
    }
  }
  return { settings: merged as Settings, sources };
}

export interface ListedSetting {
  key: string;
  // Absent for ocra's default.
  value?: unknown;
  // Empty for ocra's default.
  sources: SettingSource[];
}

/**
 * The settings --plan lists, in its order, with their sources. A setting
 * only a command-line flag set is the flag's, not a setting, and is left
 * out.
 */
export function listSettings(settings: Settings, sources: SettingSources): ListedSetting[] {
  const listed: ListedSetting[] = [];
  for (const [key, rule] of Object.entries(MERGE)) {
    const plan = rule.plan;
    if (!plan) continue;
    const value = settings[key as keyof Settings];
    const add = (name: string, shown: unknown, always: boolean) => {
      const from = (sources[name] ?? []).filter((source) => source !== "flag");
      if (from.length === 0 && !always) return;
      listed.push(
        from.length === 0 ? { key: name, sources: [] } : { key: name, value: shown, sources: from },
      );
    };
    if (rule.merge === "entries") {
      const map = value as Record<string, unknown>;
      for (const entry of plan.entries ?? Object.keys(map)) {
        add(`${key}.${entry}`, map[entry], plan.list === "always");
      }
    } else {
      add(key, plan.show ? plan.show(value as never) : value, plan.list === "always");
    }
  }
  return listed;
}
