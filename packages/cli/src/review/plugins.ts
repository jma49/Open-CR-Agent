import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { OcraPlugin } from "@open-cr-agent/core";
import { ConfigError } from "./config.js";

// Plugins listed in the repository config execute code, so they are resolved
// only from the repository's own dependencies or relative paths inside it.
export async function loadExternalPlugins(
  specifiers: readonly string[],
  root: string,
): Promise<OcraPlugin[]> {
  const plugins: OcraPlugin[] = [];
  for (const specifier of specifiers) {
    const module = await import(pathToFileURL(resolvePlugin(specifier, root)).href);
    const plugin: unknown = module.default ?? module.plugin;
    if (!isPlugin(plugin)) {
      throw new ConfigError(
        `Plugin "${specifier}" must export an ocra plugin as default or "plugin"`,
      );
    }
    plugins.push(plugin);
  }
  return plugins;
}

function resolvePlugin(specifier: string, root: string): string {
  if (specifier.startsWith(".") || isAbsolute(specifier)) return resolve(root, specifier);
  try {
    return createRequire(join(root, "package.json")).resolve(specifier);
  } catch {
    throw new ConfigError(
      `Cannot find plugin "${specifier}" from ${root}; install it as a dependency`,
    );
  }
}

function isPlugin(value: unknown): value is OcraPlugin {
  return (
    typeof value === "object" && value !== null && typeof (value as OcraPlugin).name === "string"
  );
}
