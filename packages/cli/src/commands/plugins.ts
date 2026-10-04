import { access, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "../config/cli-config.js";
import { EXIT } from "../io/exit.js";
import type { Output } from "../io/output.js";
import { forTerminal } from "../io/terminal.js";
import { UsageError } from "../io/usage-error.js";
import type { NpmRunner } from "../plugins/npm.js";
import {
  type AllowedPlugin,
  ensureDir,
  installedEntry,
  isExactVersion,
  isPackageName,
  readAllowed,
  writeAllowed,
} from "../plugins/store.js";

// `ocra plugins` (ADR-0027): the user's own decision, on each machine, to
// let their ocra Cloud account load a third-party plugin, like adding a
// dependency. The account names packages; only what is allowed here loads.

export const PLUGINS_USAGE = `Usage: ocra plugins allow <name>@<version>
       ocra plugins deny <name>
       ocra plugins list

Your ocra Cloud settings may name plugins; a review loads one only if this
machine allows it. allow shows the package and who published it, installs that
exact version with install scripts off into a directory of your own, and
records its integrity; deny removes it.
`;

export interface PluginsDeps {
  dir: string;
  npm: NpmRunner;
}

export async function pluginsCommand(
  argv: readonly string[],
  out: Output,
  deps: PluginsDeps,
): Promise<number> {
  const [action, target, ...extra] = argv;
  if (action === "--help" || action === "-h" || action === "help") {
    out.write(PLUGINS_USAGE);
    return EXIT.ok;
  }
  if (extra.length > 0) throw new UsageError(`Unexpected argument: ${extra[0]}`);
  if (action === "list" && target === undefined) return list(out, deps.dir);
  if (action === "allow" && target !== undefined) return allow(target, out, deps);
  if (action === "deny" && target !== undefined) return deny(target, out, deps);
  throw new UsageError(action ? `Unknown or incomplete command: plugins ${action}` : "");
}

async function list(out: Output, dir: string): Promise<number> {
  const allowed = await readAllowed(dir);
  if (allowed.length === 0) {
    out.write("No plugins allowed. Allow one with: ocra plugins allow <name>@<version>\n");
    return EXIT.ok;
  }
  for (const p of allowed) out.write(`${p.name}@${p.version}  ${p.integrity}\n`);
  out.write(`(installed in ${dir})\n`);
  return EXIT.ok;
}

function parseSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf("@");
  const name = at > 0 ? spec.slice(0, at) : spec;
  const version = at > 0 ? spec.slice(at + 1) : "";
  if (!isPackageName(name)) throw new UsageError(`Not an npm package name: ${forTerminal(name)}`);
  if (!isExactVersion(version)) {
    throw new UsageError(
      `Name an exact version, such as ${name}@1.2.3: a range or tag could install something else later`,
    );
  }
  return { name, version };
}

async function allow(spec: string, out: Output, deps: PluginsDeps): Promise<number> {
  const { name, version } = parseSpec(spec);
  await ensureDir(deps.dir);
  // npm installs into the nearest package.json; one of the directory's own
  // keeps it from walking up to a project.
  const manifest = join(deps.dir, "package.json");
  if (!(await exists(manifest))) {
    await writeFile(manifest, `${JSON.stringify({ private: true }, null, 2)}\n`, { mode: 0o600 });
  }
  const view = describe(await deps.npm(["view", `${name}@${version}`, "--json"], deps.dir));
  if (view.name !== name || view.version !== version) {
    throw new ConfigError(`npm did not resolve ${name}@${version} to that exact version`);
  }
  if (!view.integrity) {
    throw new ConfigError(`npm view lists no integrity for ${name}@${version}; not allowed`);
  }
  out.write(
    forTerminal(
      [
        `Package:      ${view.name}@${view.version}`,
        `Published by: ${view.publisher ?? "unknown"}`,
        `Maintainers:  ${view.maintainers.join(", ") || "unknown"}`,
        `Integrity:    ${view.integrity}`,
        `Installing into ${deps.dir} with install scripts off`,
        "",
      ].join("\n"),
    ),
  );
  await deps.npm(
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--prefix",
      deps.dir,
      `${name}@${version}`,
    ],
    deps.dir,
  );
  const installed = await installedEntry(deps.dir, name);
  if (installed?.version !== version || !installed.integrity) {
    throw new ConfigError(`npm did not install ${name}@${version} into ${deps.dir}`);
  }
  if (view.integrity !== installed.integrity) {
    throw new ConfigError(
      `${name}@${version} installed with another integrity than the registry lists; not allowed`,
    );
  }
  const entry: AllowedPlugin = { name, version, integrity: installed.integrity };
  const allowed = (await readAllowed(deps.dir)).filter((p) => p.name !== name);
  await writeAllowed(deps.dir, [...allowed, entry]);
  out.write(`Allowed ${name}@${version}: your ocra Cloud settings can now load it here.\n`);
  return EXIT.ok;
}

async function deny(name: string, out: Output, deps: PluginsDeps): Promise<number> {
  if (!isPackageName(name)) throw new UsageError(`Not an npm package name: ${forTerminal(name)}`);
  const allowed = await readAllowed(deps.dir);
  const kept = allowed.filter((p) => p.name !== name);
  if (kept.length === allowed.length) {
    out.write(`${name} was not allowed.\n`);
    return EXIT.ok;
  }
  // The record is what loading checks; removing the files is housekeeping.
  await writeAllowed(deps.dir, kept);
  try {
    await deps.npm(
      ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", deps.dir, name],
      deps.dir,
    );
  } catch {
    await rm(join(deps.dir, "node_modules", name), { recursive: true, force: true });
  }
  out.write(`Denied ${name}: it no longer loads.\n`);
  return EXIT.ok;
}

interface View {
  name?: string;
  version?: string;
  publisher?: string;
  maintainers: string[];
  integrity?: string;
}

function describe(stdout: string): View {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new ConfigError("npm view did not answer with JSON");
  }
  if (Array.isArray(data)) data = data.length === 1 ? data[0] : undefined;
  if (typeof data !== "object" || data === null) {
    throw new ConfigError("npm view did not describe one version");
  }
  const v = data as Record<string, unknown>;
  const person = (p: unknown) =>
    typeof p === "string"
      ? p
      : typeof p === "object" && p !== null && typeof (p as { name?: unknown }).name === "string"
        ? (p as { name: string }).name
        : undefined;
  const integrity =
    (v.dist as { integrity?: unknown } | undefined)?.integrity ?? v["dist.integrity"];
  const publisher = person(v._npmUser);
  return {
    ...(typeof v.name === "string" ? { name: v.name } : {}),
    ...(typeof v.version === "string" ? { version: v.version } : {}),
    ...(publisher ? { publisher } : {}),
    maintainers: (Array.isArray(v.maintainers) ? v.maintainers : [])
      .map(person)
      .filter((m): m is string => m !== undefined),
    ...(typeof integrity === "string" ? { integrity } : {}),
  };
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}
