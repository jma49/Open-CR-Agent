import type { OcraPlugin } from "@open-cr-agent/core";
import { loadAllowedPlugins } from "./load.js";
import { isPackageName } from "./store.js";

// The plugins an ocra Cloud account names, and their settings (ADR-0027):
// package names only, never a path or a version; what loads is what this
// machine allowed (`ocra plugins allow`).

export interface AccountPlugins {
  plugins: string[];
  // By package name, as ocra Cloud stores and validates them (the account
  // names packages, not the plugins they export); applied only to plugins
  // the account itself lists and this machine loads, under their plugin name.
  pluginSettings: Record<string, unknown>;
}

const MAX_PLUGINS = 50;

export function parseAccountPlugins(
  body: unknown,
  warn: (message: string) => void,
): AccountPlugins {
  const settings = record(record(body).settings);
  const listed = Array.isArray(settings.plugins) ? settings.plugins : [];
  const plugins = [
    ...new Set(listed.filter((p): p is string => typeof p === "string" && isPackageName(p))),
  ].slice(0, MAX_PLUGINS);
  const refused = listed.filter((p) => typeof p !== "string" || !isPackageName(p));
  if (refused.length > 0 || (settings.plugins !== undefined && !Array.isArray(settings.plugins))) {
    warn(
      `ignoring plugins in your ocra Cloud settings that are not npm package names: ${refused.map((p) => JSON.stringify(p)).join(", ") || JSON.stringify(settings.plugins)}`,
    );
  }
  if (listed.length > MAX_PLUGINS) {
    warn(`your ocra Cloud settings name more than ${MAX_PLUGINS} plugins; the rest are ignored`);
  }
  return { plugins, pluginSettings: record(settings.pluginSettings) };
}

/**
 * The account's plugins this review loads, and their settings. Only where a
 * repository's plugins could load (allowed: never for pull or merge requests,
 * never with --no-repo-config); a package the configuration already lists
 * loads as the configuration's, and a plugin whose name is taken is skipped.
 */
export async function loadAccountPlugins(
  account: AccountPlugins,
  options: {
    allowed: boolean;
    configured: readonly string[];
    taken: readonly OcraPlugin[];
    dir: string;
    warn: (message: string) => void;
  },
): Promise<{ plugins: OcraPlugin[]; settings: Record<string, unknown> }> {
  const names = account.plugins.filter((name) => !options.configured.includes(name));
  if (names.length === 0) return { plugins: [], settings: {} };
  if (!options.allowed) {
    options.warn(
      `plugins from your ocra Cloud settings do not load for pull or merge requests or with --no-repo-config: ${names.join(", ")}`,
    );
    return { plugins: [], settings: {} };
  }
  const taken = new Set(options.taken.map((p) => p.name));
  const plugins: OcraPlugin[] = [];
  const settings: Record<string, unknown> = {};
  for (const { name, plugin } of await loadAllowedPlugins(names, options.dir, options.warn)) {
    if (taken.has(plugin.name)) {
      options.warn(
        `skipping plugin ${name} from your ocra Cloud settings: a plugin named "${plugin.name}" is already loaded`,
      );
      continue;
    }
    taken.add(plugin.name);
    plugins.push(plugin);
    if (Object.hasOwn(account.pluginSettings, name)) {
      settings[plugin.name] = account.pluginSettings[name];
    }
  }
  return { plugins, settings };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
