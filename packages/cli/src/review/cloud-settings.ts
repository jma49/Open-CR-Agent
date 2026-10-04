import type { ModelTier } from "@open-cr-agent/core";
import { type CloudDeps, cloudSession } from "../cloud.js";
import { VERSION } from "../version.js";
import { type AccountSettings, type CliConfig, parseAccountSettings } from "./config.js";

// ocra Cloud's account settings fill what the repository's configuration
// leaves out (ADR-0025): a tier's models and effort, a reviewer's or role's
// whole entry, and the runtime. What the configuration sets always wins.

const TIERS: readonly ModelTier[] = ["top", "standard", "light"];

export async function fetchAccountSettings(
  deps: CloudDeps,
  warn: (message: string) => void,
): Promise<AccountSettings | undefined> {
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
  const settings = parseAccountSettings(await res.json().catch(() => undefined));
  if (!settings) warn("ignoring your ocra Cloud settings: they do not match this version of ocra");
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
    const chain = account.models[tier];
    if (!config.models[tier]?.length && chain) {
      models[tier] = typeof chain === "string" ? [chain] : chain;
      filled.push(`models.${tier}`);
    }
    if (config.effort[tier] === undefined && account.effort[tier] !== undefined) {
      effort[tier] = account.effort[tier];
      filled.push(`effort.${tier}`);
    }
  }
  const reviewers = { ...config.reviewers };
  for (const [id, entry] of Object.entries(account.reviewers)) {
    if (reviewers[id] === undefined) {
      reviewers[id] = entry;
      filled.push(`reviewers.${id}`);
    }
  }
  const roles = { ...config.roles };
  for (const [role, entry] of Object.entries(account.roles) as [
    keyof typeof roles,
    (typeof roles)[keyof typeof roles],
  ][]) {
    if (roles[role] === undefined && entry) {
      roles[role] = entry;
      filled.push(`roles.${role}`);
    }
  }
  let { runtime, runtimeSet } = config;
  if (!config.runtimeSet && account.runtime) {
    runtime = account.runtime;
    runtimeSet = true;
    filled.push("runtime");
  }
  return { config: { ...config, models, effort, reviewers, roles, runtime, runtimeSet }, filled };
}
