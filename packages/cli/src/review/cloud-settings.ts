import type { ModelTier, SourcedRule } from "@open-cr-agent/core";
import { type CloudDeps, cloudSession } from "../cloud.js";
import { VERSION } from "../version.js";
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

/** The account's settings; undefined when signed out or unreachable (a warning says which). */
export async function fetchAccountSettings(
  deps: CloudDeps,
  warn: (message: string) => void,
): Promise<AccountSettings | undefined> {
  let body: unknown;
  try {
    const session = await cloudSession(deps);
    if (!session) return undefined;
    const res = await deps.fetch(`${session.server}/api/preferences`, {
      headers: { authorization: `Bearer ${session.access_token}`, "user-agent": `ocra/${VERSION}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      warn(
        `could not read your ocra Cloud settings (HTTP ${res.status}); the review uses the repository's`,
      );
      return undefined;
    }
    body = await res.json();
  } catch (error) {
    warn(
      `could not read your ocra Cloud settings (${(error as Error).message}); the review uses the repository's`,
    );
    return undefined;
  }
  if (typeof body !== "object" || body === null) {
    warn("ignoring your ocra Cloud settings: the server's answer is not an object");
    return undefined;
  }
  const { settings, warnings } = parseAccountSettings(body);
  for (const warning of warnings) warn(warning);
  return settings;
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
