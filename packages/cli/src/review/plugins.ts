import { realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { OcraPlugin } from "@open-cr-agent/core";
import { installedEntry, readAllowed } from "../plugin-store.js";
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

/**
 * The plugins an ocra Cloud account names that this machine allowed: each
 * from the allowed directory alone, at the version and integrity recorded
 * when it was allowed. Anything else is skipped with a warning; an account
 * plugin never fails the review.
 */
export async function loadAccountPlugins(
  names: readonly string[],
  dir: string,
  warn: (message: string) => void,
): Promise<{ name: string; plugin: OcraPlugin }[]> {
  const allowed = new Map((await readAllowed(dir)).map((p) => [p.name, p]));
  const missing = names.filter((name) => !allowed.has(name));
  if (missing.length > 0) {
    warn(
      `your ocra Cloud settings name plugins this machine has not allowed, so they do not load: ${missing.join(", ")}; allow each with ocra plugins allow <name>@<version>`,
    );
  }
  const loaded: { name: string; plugin: OcraPlugin }[] = [];
  for (const name of names) {
    const record = allowed.get(name);
    if (!record) continue;
    try {
      const installed = await installedEntry(dir, name);
      if (installed?.version !== record.version || installed.integrity !== record.integrity) {
        throw new Error(
          `it is not the ${record.version} allowed here; run ocra plugins allow ${name}@<version> again`,
        );
      }
      const module = await import(pathToFileURL(await allowedEntry(dir, name)).href);
      const plugin: unknown = module.default ?? module.plugin;
      if (!isPlugin(plugin)) throw new Error('it exports no ocra plugin as default or "plugin"');
      loaded.push({ name, plugin });
    } catch (error) {
      warn(`skipping plugin ${name} from your ocra Cloud settings: ${(error as Error).message}`);
    }
  }
  return loaded;
}

// Node's resolution walks up past the directory to any node_modules above
// it; the entry must be inside the allowed package itself.
async function allowedEntry(dir: string, name: string): Promise<string> {
  const entry = await realpath(createRequire(join(dir, "package.json")).resolve(name));
  const root = await realpath(join(dir, "node_modules", name));
  if (!entry.startsWith(`${root}${sep}`)) throw new Error(`it resolves outside ${dir}`);
  return entry;
}
