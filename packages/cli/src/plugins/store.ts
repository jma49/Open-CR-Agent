import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { ocraConfigDir } from "../config/user-dir.js";
import { ConfigError } from "../review/config.js";

// The plugins this machine allows its ocra Cloud account to name (ADR-0027):
// installed by `ocra plugins allow` into a directory of the user's own, never
// the reviewed checkout, and recorded with the integrity npm installed.

// npm's package-name rules, less a leading "-" or "." that npm could read as
// an option or a path; at most 214 characters.
const PACKAGE_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/;
// An exact version: no range, tag or URL.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function isPackageName(name: string): boolean {
  return name.length <= 214 && PACKAGE_NAME.test(name);
}

export function isExactVersion(version: string): boolean {
  return version.length <= 256 && EXACT_VERSION.test(version);
}

const allowedSchema = z
  .object({
    name: z.string().refine(isPackageName),
    version: z.string().refine(isExactVersion),
    integrity: z.string().min(1),
  })
  .strict();
export type AllowedPlugin = z.infer<typeof allowedSchema>;

const fileSchema = z.object({ plugins: z.array(allowedSchema) }).strict();

export function pluginsDir(env: Readonly<Record<string, string | undefined>>): string {
  return join(ocraConfigDir(env), "plugins");
}

export async function readAllowed(dir: string): Promise<AllowedPlugin[]> {
  let text: string;
  try {
    text = await readFile(join(dir, "plugins.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = undefined;
  }
  const parsed = fileSchema.safeParse(data);
  if (!parsed.success) {
    throw new ConfigError(
      `${join(dir, "plugins.json")} is invalid; allow the plugins again or remove it`,
    );
  }
  return parsed.data.plugins;
}

export async function writeAllowed(dir: string, plugins: readonly AllowedPlugin[]): Promise<void> {
  await ensureDir(dir);
  const path = join(dir, "plugins.json");
  const sorted = [...plugins].sort((a, b) => (a.name < b.name ? -1 : 1));
  await writeFile(path, `${JSON.stringify({ plugins: sorted }, null, 2)}\n`, { mode: 0o600 });
  // writeFile keeps the mode of a file that already exists.
  await chmod(path, 0o600);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** What npm's lockfile in the directory says it installed for a package. */
export async function installedEntry(
  dir: string,
  name: string,
): Promise<{ version?: string; integrity?: string } | undefined> {
  let lock: unknown;
  try {
    lock = JSON.parse(await readFile(join(dir, "package-lock.json"), "utf8"));
  } catch {
    return undefined;
  }
  const entry = (lock as { packages?: Record<string, unknown> }).packages?.[`node_modules/${name}`];
  if (typeof entry !== "object" || entry === null) return undefined;
  const { version, integrity } = entry as { version?: unknown; integrity?: unknown };
  return {
    ...(typeof version === "string" ? { version } : {}),
    ...(typeof integrity === "string" ? { integrity } : {}),
  };
}
