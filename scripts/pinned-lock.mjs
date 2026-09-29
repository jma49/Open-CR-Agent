// A package-lock.json for installing one published workspace package, the
// CLI, outside this repository with every third-party dependency at the
// version this repository's lockfile pins: the versions CI tested and
// `npm audit` checked, rather than whatever the ranges resolve to on the day
// of the install. The GitHub Action installs ocra this way (see
// scripts/action-install.mjs). Pure: no git, npm or network.
//
// npm-shrinkwrap.json would pin the tree for `npm install -g` too, but npm
// installs a dependency's shrinkwrap without its platform checks: every
// OpenCode binary for every OS and CPU, 2.1 GB (docs/pitfalls.md).
import { relative, sep } from "node:path";

const EDGES = [
  ["dependencies", { optional: false, peer: false }],
  ["optionalDependencies", { optional: true, peer: false }],
  ["peerDependencies", { optional: false, peer: true }],
];

// Flags a lockfile entry has relative to the project it was resolved for;
// recomputed for the new project.
const PROJECT_FLAGS = ["dev", "devOptional", "optional", "peer", "extraneous"];

const MANIFEST_FIELDS = [
  "license",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bin",
  "engines",
  "os",
  "cpu",
];

export function registryUrl(name, version, registry = "https://registry.npmjs.org") {
  const base = name.split("/").pop();
  return `${registry.replace(/\/$/, "")}/${name}/-/${base}-${version}.tgz`;
}

// Where Node looks for `name` when required from the package at `from`, as
// lockfile paths: its own node_modules, then each enclosing one up to the
// root. A workspace directory ("packages/cli") sits directly under the root.
export function lookupPaths(from, name) {
  const paths = [];
  let base = from;
  for (;;) {
    paths.push(base === "" ? `node_modules/${name}` : `${base}/node_modules/${name}`);
    if (base === "") return paths;
    const nested = base.lastIndexOf("/node_modules/");
    base = nested === -1 ? "" : base.slice(0, nested);
  }
}

// options:
//   lock        the repository's package-lock.json, parsed (version 3)
//   root        the repository root
//   workspaces  readWorkspaces(root)
//   target      the workspace package to install
//   integrity   (name) => the integrity of that workspace package's tarball
//   resolved    (name, version) => where that tarball is; the registry by default
// Returns the manifest and the lockfile of a project that depends on target.
export function pinnedLockfile({
  lock,
  root: repository,
  workspaces,
  target,
  integrity,
  resolved = registryUrl,
}) {
  if (lock?.lockfileVersion !== 3) {
    throw new Error(`package-lock.json has lockfile version ${lock?.lockfileVersion}, not 3`);
  }
  const entries = lock.packages ?? {};
  const byDir = new Map();
  for (const w of workspaces) {
    byDir.set(relative(repository, w.dir).split(sep).join("/"), w.json);
  }
  const start = [...byDir].find(([, json]) => json.name === target)?.[0];
  if (start === undefined) throw new Error(`${target} is not a workspace package`);

  // The lockfile path a dependency of the package at `from` resolves to,
  // following workspace links, or undefined.
  const resolve = (from, name) => {
    for (const path of lookupPaths(from, name)) {
      const entry = entries[path];
      if (!entry) continue;
      if (!entry.link) return path;
      if (!byDir.has(entry.resolved)) {
        throw new Error(`${path} links to ${entry.resolved}, which is not a workspace package`);
      }
      return entry.resolved;
    }
    return undefined;
  };

  // Every package the target needs installed. As npm marks them, a package
  // is optional when every path to it passes an optional dependency, and
  // peer when every path to it passes a peer dependency.
  const state = new Map([[start, { optional: false, peer: false }]]);
  const queue = [start];
  while (queue.length > 0) {
    const from = queue.shift();
    const here = state.get(from);
    const manifest = byDir.get(from) ?? entries[from];
    for (const [field, kind] of EDGES) {
      for (const name of Object.keys(manifest[field] ?? {})) {
        if (kind.peer && manifest.peerDependenciesMeta?.[name]?.optional) continue;
        const to = resolve(from, name);
        if (to === undefined) {
          if (kind.optional || here.optional) continue;
          throw new Error(`package-lock.json has no ${name} for ${manifest.name ?? from}`);
        }
        if (byDir.get(to)?.private) {
          throw new Error(`${manifest.name ?? from} needs ${name}, which is private`);
        }
        const next = { optional: here.optional || kind.optional, peer: here.peer || kind.peer };
        const seen = state.get(to);
        if (!seen) {
          state.set(to, next);
          queue.push(to);
        } else if ((seen.optional && !next.optional) || (seen.peer && !next.peer)) {
          state.set(to, { optional: seen.optional && next.optional, peer: seen.peer && next.peer });
          queue.push(to);
        }
      }
    }
  }

  // Workspace packages install from their tarballs under node_modules, with
  // anything nested in their directories nested under them; the rest keeps
  // the repository's layout, so every dependency resolves as it did there.
  const place = (path) => {
    for (const [dir, json] of byDir) {
      if (path === dir) return `node_modules/${json.name}`;
      if (path.startsWith(`${dir}/`))
        return `node_modules/${json.name}/${path.slice(dir.length + 1)}`;
    }
    return path;
  };

  const project = {
    name: "ocra-install",
    private: true,
    dependencies: { [target]: byDir.get(start).version },
  };
  const packages = { "": { name: project.name, dependencies: project.dependencies } };
  const placed = new Map();
  for (const [path, flags] of state) {
    const at = place(path);
    if (placed.has(at))
      throw new Error(`${path} and ${placed.get(at)} would both install at ${at}`);
    placed.set(at, path);
    const workspace = byDir.get(path);
    const entry = workspace ? fromManifest(workspace, integrity, resolved) : { ...entries[path] };
    for (const flag of PROJECT_FLAGS) delete entry[flag];
    if (flags.optional) entry.optional = true;
    if (flags.peer) entry.peer = true;
    if (!entry.inBundle && (!entry.version || !entry.resolved || !entry.integrity)) {
      throw new Error(`${path} has no version, resolved URL or integrity`);
    }
    packages[at] = entry;
  }

  const keys = Object.keys(packages).sort((a, b) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b, "en"),
  );
  return {
    manifest: project,
    lockfile: {
      name: project.name,
      lockfileVersion: 3,
      requires: true,
      packages: Object.fromEntries(keys.map((key) => [key, packages[key]])),
    },
  };
}

function fromManifest(json, integrity, resolved) {
  const entry = {
    version: json.version,
    resolved: resolved(json.name, json.version),
    integrity: integrity(json.name),
  };
  for (const field of MANIFEST_FIELDS) {
    if (json[field] !== undefined) entry[field] = json[field];
  }
  return entry;
}
