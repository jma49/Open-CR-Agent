import type { SourcedRule } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core/internal";
import type { SettingsLayer } from "../config/settings.js";
import { type AccountPlugins, parseAccountPlugins } from "../plugins/account.js";
import { type AccountSettings, parseAccountSettings } from "./account-settings.js";
import { CloudClient, type CloudResult, type CloudSessionLost } from "./client.js";
import type { CloudDeps } from "./deps.js";

// ocra Cloud's account settings fill what the repository's configuration
// leaves out (ADR-0025, ADR-0027): a tier's models and effort, a reviewer's
// or role's whole entry, the runtime and each limit. What the configuration
// sets always wins; include, exclude and rules combine, the repository's
// first.

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
  let answer: CloudResult<Record<string, unknown>>;
  try {
    answer = await new CloudClient(deps).preferences();
  } catch (error) {
    return { kind: "unreachable", reason: errorMessage(error) };
  }
  if (answer.kind === "status") {
    // A server without account settings has none to apply.
    if (answer.status === 404) return { kind: "read", plugins: NO_PLUGINS };
    if (answer.status >= 500 || answer.status === 429) {
      return { kind: "unreachable", reason: `HTTP ${answer.status}` };
    }
    warn(
      `could not read your ocra Cloud settings (HTTP ${answer.status}); the review uses the repository's`,
    );
    return { kind: "read", plugins: NO_PLUGINS };
  }
  if (answer.kind === "malformed") {
    warn("ignoring your ocra Cloud settings: the server's answer is not an object");
    return { kind: "read", plugins: NO_PLUGINS };
  }
  if (answer.kind !== "ok") return answer;
  const body = answer.value;
  const { settings, warnings } = parseAccountSettings(body);
  for (const warning of warnings) warn(warning);
  return {
    kind: "read",
    ...(settings ? { settings } : {}),
    plugins: parseAccountPlugins(body, warn),
  };
}

/**
 * The account's settings as the layer under the configuration: they fill
 * what it leaves out, and add to its include, exclude and rules.
 */
export function accountLayer(account: AccountSettings): SettingsLayer {
  const { version: _, rules, ultra, ...settings } = account;
  return {
    source: "account",
    under: true,
    settings: {
      ...settings,
      ...(rules
        ? { rules: rules.map((rule): SourcedRule => ({ ...rule, source: "account" })) }
        : {}),
      // The account's default for --ultra; there is no --no-ultra to refuse it.
      ...(ultra === true ? { ultra } : {}),
    },
  };
}
