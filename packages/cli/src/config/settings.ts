import { isDeepStrictEqual } from "node:util";
import { OcraError, type SourcedRule } from "@open-cr-agent/core";
import { z } from "zod";
import { configSchema } from "./schema.js";

// A review's settings come in layers: a shared configuration (extends), the
// repository's file or the user's own (--config), OCRA_* variables, and the
// ocra Cloud account's settings under them all (ADR-0027). One merge
// applies them and records, per setting, the layers its value came from,
// so what --plan reports is what was applied.

type FileSettings = z.output<typeof configSchema>;

export type Settings = FileSettings & {
  // A shared configuration's rules, then the account's.
  rules: SourcedRule[];
};

export type SettingSource = "shared" | "file" | "env" | "account";

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

const ALL = ["shared", "file", "env", "account"] as const;
const NOT_ENV = ["shared", "file", "account"] as const;

// How each setting merges, and which layers may set it: a shared
// configuration is fetched from outside the repository, so it never names
// plugins or a runtime; the account never moves code or keys (providers,
// extends) or decides whose comments are trusted (github). The layers'
// parsers refuse these with a warning; here they are a broken invariant.
const MERGE: {
  readonly [K in keyof Settings]-?: { merge: Merge; from: readonly SettingSource[] };
} = {
  $schema: { merge: "replace", from: ["shared", "file"] },
  models: { merge: "entries", from: ALL },
  effort: { merge: "entries", from: ALL },
  concurrency: { merge: "replace", from: NOT_ENV },
  taskTimeoutMinutes: { merge: "replace", from: NOT_ENV },
  runTimeoutMinutes: { merge: "replace", from: NOT_ENV },
  verify: { merge: "replace", from: NOT_ENV },
  judge: { merge: "replace", from: NOT_ENV },
  maxCostUsd: { merge: "replace", from: NOT_ENV },
  maxTasks: { merge: "replace", from: NOT_ENV },
  sampling: { merge: "replace", from: ["file", "account"] },
  github: { merge: "entries", from: ["shared", "file"] },
  include: { merge: "concat", from: NOT_ENV },
  exclude: { merge: "concat", from: NOT_ENV },
  runtime: { merge: "replace", from: ["file", "account"] },
  plugins: { merge: "replace", from: ["file"] },
  reviewers: { merge: "entries", from: NOT_ENV },
  roles: { merge: "entries", from: NOT_ENV },
  pluginSettings: { merge: "replace", from: ["file"] },
  providers: { merge: "entries", from: ["shared", "file"] },
  extends: { merge: "replace", from: ["file"] },
  rules: { merge: "concat", from: ["shared", "account"] },
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
  .strict() as unknown as z.ZodType<Omit<LayerSettings, "rules">>;

/** The layers, earliest first, over ocra's defaults, and where each setting came from. */
export function resolveSettings(layers: readonly SettingsLayer[]): {
  settings: Settings;
  sources: SettingSources;
} {
  const merged: Record<string, unknown> = { ...configSchema.parse({}), rules: [] };
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
