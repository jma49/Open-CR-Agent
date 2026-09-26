import { errorMessage } from "../errors.js";
import { REVIEW_TOOLS } from "../review/tools.js";
import { PluginError, PluginRegistry } from "./registry.js";
import type { BootstrapContext, ConfigureContext, Env, OcraPlugin } from "./types.js";

export interface PluginHostOptions {
  settings?: Readonly<Record<string, unknown>>;
  env?: Env;
  warn?: (message: string) => void;
}

// Lifecycle follows Cloudflare's ReviewPlugin: bootstrap hooks run
// concurrently and may fail without stopping the run; configure hooks run in
// order and any failure is fatal; postConfigure hooks see the frozen registry.
export async function startPlugins(
  plugins: readonly OcraPlugin[],
  options: PluginHostOptions = {},
): Promise<PluginRegistry> {
  assertUniqueNames(plugins);
  const env = options.env ?? {};
  const warn = options.warn ?? (() => {});
  const registry = new PluginRegistry(new Set(Object.values(REVIEW_TOOLS)), warn);
  const settings = new Map(
    plugins.map((p) => [p.name, parseSettings(p, options.settings?.[p.name])]),
  );
  const base = (plugin: OcraPlugin) => ({ settings: settings.get(plugin.name), env, warn });

  const bootstraps = await Promise.allSettled(plugins.map((p) => p.bootstrap?.(base(p))));
  bootstraps.forEach((result, i) => {
    if (result.status === "rejected") {
      warn(`Plugin "${plugins[i]?.name}" bootstrap failed: ${errorMessage(result.reason)}`);
    }
  });

  for (const plugin of plugins) {
    try {
      await plugin.configure?.(configureContext(plugin, registry, base(plugin)));
    } catch (error) {
      if (error instanceof PluginError) throw error;
      throw new PluginError(`Plugin "${plugin.name}" failed to configure: ${errorMessage(error)}`);
    }
  }
  registry.freeze();

  const registered = registry.summary(plugins.map((p) => p.name));
  await Promise.all(
    plugins.map(async (plugin) => {
      try {
        await plugin.postConfigure?.({ ...base(plugin), registered });
      } catch (error) {
        throw new PluginError(
          `Plugin "${plugin.name}" failed after configure: ${errorMessage(error)}`,
        );
      }
    }),
  );
  return registry;
}

function configureContext(
  plugin: OcraPlugin,
  registry: PluginRegistry,
  base: BootstrapContext,
): ConfigureContext {
  const owner = plugin.name;
  return {
    ...base,
    registerVcs: (name, factory) => registry.registerVcs(owner, name, factory),
    registerRuntime: (name, factory) => registry.registerRuntime(owner, name, factory),
    registerReviewer: (reviewer) => registry.registerReviewer(owner, reviewer),
    registerRules: (rules) => registry.registerRules(owner, rules),
    registerTool: (tool) => registry.registerTool(owner, tool),
    onEvent: (listener) => registry.onEvent(owner, listener),
  };
}

function parseSettings(plugin: OcraPlugin, raw: unknown): unknown {
  if (!plugin.settingsSchema) return raw;
  const parsed = plugin.settingsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new PluginError(`Invalid settings for plugin "${plugin.name}": ${parsed.error.message}`);
  }
  return parsed.data;
}

function assertUniqueNames(plugins: readonly OcraPlugin[]): void {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) throw new PluginError(`Plugin "${plugin.name}" is loaded twice`);
    seen.add(plugin.name);
  }
}
