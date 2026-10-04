import type { ModelTier, SourcedRule } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core/internal";
import { type CloudDeps, type CloudSessionLost, cloudFetch } from "../cloud.js";
import { type AccountPlugins, parseAccountPlugins } from "./account-plugins.js";
import { type AccountSettings, parseAccountSettings } from "./account-settings.js";
import type { CliConfig } from "./config.js";

// ocra Cloud's account settings fill what the repository's configuration
// leaves out (ADR-0025, ADR-0027): a tier's models and effort, a reviewer's
// or role's whole entry, the runtime and each limit. What the configuration
// sets always wins; include, exclude and rules combine, the repository's
// first.

const TIERS: readonly ModelTier[] = ["top", "standard", "light"];

// Each set by the configuration or else by the account, whole.
export const ACCOUNT_SCALARS = [
  "concurrency",
  "taskTimeoutMinutes",
  "runTimeoutMinutes",
  "maxCostUsd",
  "maxTasks",
  "verify",
  "judge",
  "sampling",
] as const;

export type AccountRead =
  | { kind: "read"; settings?: AccountSettings; plugins: AccountPlugins }
  | CloudSessionLost;

const NO_PLUGINS: AccountPlugins = { plugins: [], pluginSettings: {} };

/**
 * The account's settings. A server that cannot be reached, or a session
 * that ended, is answered for the caller to say once what the run loses;
 * an answer that cannot be used is a warning here and no settings.
 */
export async function fetchAccountSettings(
  deps: CloudDeps,
  warn: (message: string) => void,
): Promise<AccountRead> {
  let body: unknown;
  try {
    const answer = await cloudFetch(deps, "/api/preferences");
    if (answer.kind !== "answered") return answer;
    const { res } = answer;
    // A server without account settings has none to apply.
    if (res.status === 404) return { kind: "read", plugins: NO_PLUGINS };
    if (res.status >= 500 || res.status === 429) {
      return { kind: "unreachable", reason: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      warn(
        `could not read your ocra Cloud settings (HTTP ${res.status}); the review uses the repository's`,
      );
      return { kind: "read", plugins: NO_PLUGINS };
    }
    body = await res.json();
  } catch (error) {
    return { kind: "unreachable", reason: errorMessage(error) };
  }
  if (typeof body !== "object" || body === null) {
    warn("ignoring your ocra Cloud settings: the server's answer is not an object");
    return { kind: "read", plugins: NO_PLUGINS };
  }
  const { settings, warnings } = parseAccountSettings(body);
  for (const warning of warnings) warn(warning);
  return {
    kind: "read",
    ...(settings ? { settings } : {}),
    plugins: parseAccountPlugins(body, warn),
  };
}

/** The configuration with the account's settings under it, and what they filled in. */
export function layerAccountSettings(
  config: CliConfig,
  account: AccountSettings,
): { config: CliConfig; filled: string[] } {
  const filled: string[] = [];
  const models = { ...config.models };
  const effort = { ...config.effort };
  for (const tier of TIERS) {
    const chain = account.models?.[tier];
    if (!config.models[tier]?.length && chain) {
      models[tier] = chain;
      filled.push(`models.${tier}`);
    }
    const level = account.effort?.[tier];
    if (config.effort[tier] === undefined && level !== undefined) {
      effort[tier] = level;
      filled.push(`effort.${tier}`);
    }
  }
  const reviewers = { ...config.reviewers };
  for (const [id, entry] of Object.entries(account.reviewers ?? {})) {
    if (reviewers[id] === undefined) {
      reviewers[id] = entry;
      filled.push(`reviewers.${id}`);
    }
  }
  const roles = { ...config.roles };
  for (const [role, entry] of Object.entries(account.roles ?? {}) as [
    keyof typeof roles,
    (typeof roles)[keyof typeof roles],
  ][]) {
    if (roles[role] === undefined && entry) {
      roles[role] = entry;
      filled.push(`roles.${role}`);
    }
  }
  const out: CliConfig = {
    ...config,
    models,
    effort,
    reviewers,
    roles,
    accountSettings: { version: account.version },
  };
  if (!config.runtimeSet && account.runtime) {
    out.runtime = account.runtime;
    out.runtimeSet = true;
    filled.push("runtime");
  }
  for (const key of ACCOUNT_SCALARS) {
    if (config[key] === undefined && account[key] !== undefined) {
      Object.assign(out, { [key]: account[key] });
      filled.push(key);
    }
  }
  for (const key of ["include", "exclude"] as const) {
    const added = (account[key] ?? []).filter((glob) => !config[key].includes(glob));
    if (added.length > 0) {
      out[key] = [...config[key], ...added];
      filled.push(key);
    }
  }
  if (account.rules?.length) {
    out.rules = [
      ...config.rules,
      ...account.rules.map((rule): SourcedRule => ({ ...rule, source: "account" })),
    ];
    filled.push("rules");
  }
  return { config: out, filled };
}
