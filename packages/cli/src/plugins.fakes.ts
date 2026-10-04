import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CloudDeps } from "./cloud.js";
import { readAllowed, writeAllowed } from "./plugin-store.js";
import type { NpmRunner } from "./plugins-command.js";

// A fake npm for `ocra plugins` and account plugin loading: `view` describes
// the packages it knows, `install` writes them into the --prefix directory
// with a lockfile, as npm would. No network.

export interface FakePackage {
  publisher?: string;
  maintainers?: string[];
  integrity: string;
  // Installed with another integrity than the registry lists.
  installedIntegrity?: string;
  // The module's source; default: a plugin that registers a rule naming its settings.
  source?: string;
}

export const ACCOUNT_PLUGIN_SOURCE = `export default {
  name: "acct-plugin",
  configure(ctx) {
    ctx.registerRules([
      { path: "**", rule: "ACCOUNT PLUGIN RULE " + JSON.stringify(ctx.settings ?? null) },
    ]);
  },
};
`;

export function fakeNpm(packages: Record<string, FakePackage>): {
  npm: NpmRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const npm: NpmRunner = async (args) => {
    calls.push([...args]);
    const [command] = args;
    if (command === "view") {
      const spec = args[1] ?? "";
      const pkg = packages[spec];
      if (!pkg) throw new Error(`npm view: ${spec} not found`);
      const at = spec.lastIndexOf("@");
      return JSON.stringify({
        name: spec.slice(0, at),
        version: spec.slice(at + 1),
        _npmUser: pkg.publisher,
        maintainers: pkg.maintainers ?? [],
        dist: { integrity: pkg.integrity },
      });
    }
    const dir = args[args.indexOf("--prefix") + 1] ?? "";
    const spec = args.at(-1) ?? "";
    if (command === "install") {
      const pkg = packages[spec];
      if (!pkg) throw new Error(`npm install: ${spec} not found`);
      const at = spec.lastIndexOf("@");
      const [name, version] = [spec.slice(0, at), spec.slice(at + 1)];
      install(dir, name, version, pkg.installedIntegrity ?? pkg.integrity, pkg.source);
      return "";
    }
    if (command === "uninstall") {
      rmSync(join(dir, "node_modules", spec), { recursive: true, force: true });
      return "";
    }
    throw new Error(`unexpected npm ${command}`);
  };
  return { npm, calls };
}

export function install(
  dir: string,
  name: string,
  version: string,
  integrity: string,
  source = ACCOUNT_PLUGIN_SOURCE,
): void {
  const root = join(dir, "node_modules", name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name, version, type: "module", main: "index.js" }),
  );
  writeFileSync(join(root, "index.js"), source);
  const lockPath = join(dir, "package-lock.json");
  const lock = existsSync(lockPath)
    ? JSON.parse(readFileSync(lockPath, "utf8"))
    : { lockfileVersion: 3, packages: {} };
  lock.packages[`node_modules/${name}`] = { version, integrity };
  writeFileSync(lockPath, JSON.stringify(lock));
}

/** A signed-in ocra Cloud whose settings answer `preferences`; credentials under home/ocra. */
export function signedInCloud(home: string, preferences: unknown): CloudDeps {
  const credentialsPath = join(home, "ocra", "credentials.json");
  mkdirSync(join(home, "ocra"), { recursive: true });
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      server: "https://cloud.test",
      login: "octo",
      access_token: "ocra_cli_t",
      refresh_token: "ocra_ref_r",
      expires_at: Date.now() + 3_600_000,
    }),
  );
  return {
    env: {},
    fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/preferences") return Response.json(preferences);
      if (path === "/api/reviews") return Response.json({ id: "r1" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch,
    now: Date.now,
    sleep: async () => {},
    openBrowser: () => {},
    credentialsPath,
    clientName: "t",
  };
}

/** A plugin installed and allowed in dir, as `ocra plugins allow` leaves it. */
export async function allowInstalled(dir: string, name: string, source?: string): Promise<void> {
  install(dir, name, "1.0.0", "sha512-ok", source);
  const allowed = (await readAllowed(dir)).filter((p) => p.name !== name);
  await writeAllowed(dir, [...allowed, { name, version: "1.0.0", integrity: "sha512-ok" }]);
}
