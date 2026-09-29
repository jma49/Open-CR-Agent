// The parts of scripts/release.mjs that need no git, npm or network, so
// they can be tested.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function isVersion(text) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(text ?? "");
}

// Every packages/* directory with a package.json, sorted by directory name.
export function readWorkspaces(root) {
  const base = join(root, "packages");
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      const dir = join(base, name);
      return { dir, json: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) };
    });
}

// The workspace packages are released together at one version and depend on
// each other at exactly that version, so a published cli never pairs with a
// core from another release.
export function lockstep(workspaces) {
  const version = workspaces[0]?.json.version;
  const names = new Set(workspaces.map((w) => w.json.name));
  const problems = [];
  for (const { json } of workspaces) {
    if (json.version !== version) problems.push(`${json.name} is ${json.version}, not ${version}`);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (names.has(name) && range !== version) {
          problems.push(`${json.name} depends on ${name}@${range}, not ${version}`);
        }
      }
    }
  }
  return { version, problems };
}

// A copy of the manifests at one version, internal dependencies included.
export function withVersion(workspaces, version) {
  const names = new Set(workspaces.map((w) => w.json.name));
  return workspaces.map(({ dir, json }) => {
    const next = { ...json, version };
    for (const field of DEPENDENCY_FIELDS) {
      if (!json[field]) continue;
      next[field] = Object.fromEntries(
        Object.entries(json[field]).map(([name, range]) => [
          name,
          names.has(name) ? version : range,
        ]),
      );
    }
    return { dir, json: next };
  });
}

// The packages to publish, each after the workspace packages it needs at
// install time.
export function publishOrder(workspaces) {
  const byName = new Map(workspaces.map((w) => [w.json.name, w]));
  const order = [];
  const visiting = new Set();
  const visit = (w) => {
    if (order.includes(w)) return;
    if (visiting.has(w)) throw new Error(`dependency cycle through ${w.json.name}`);
    visiting.add(w);
    const needs = ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
      Object.keys(w.json[field] ?? {}),
    );
    for (const name of needs) {
      const dep = byName.get(name);
      if (!dep) continue;
      if (dep.json.private) throw new Error(`${w.json.name} needs ${name}, which is private`);
      visit(dep);
    }
    visiting.delete(w);
    order.push(w);
  };
  for (const w of workspaces) if (!w.json.private) visit(w);
  return order;
}

// Compares the x.y.z part of two versions; false for anything unparsable.
export function atLeast(version, minimum) {
  const parse = (v) => (v ?? "").split("-")[0].split(".").map(Number);
  const [have, need] = [parse(version), parse(minimum)];
  if (have.length !== 3 || have.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

// A prerelease must not become what `npm install` picks by default.
export function distTag(version) {
  return version.includes("-") ? "next" : "latest";
}

// The file name `npm pack` gives a package.
export function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

// Why a CI run must not publish from this ref, or undefined. Publishing
// from CI runs on the release tag; a dry run may run on a branch.
export function refProblem(version, ref, publish) {
  if (ref.type === "tag") {
    return ref.name === `v${version}`
      ? undefined
      : `the tag ${ref.name} does not match the package version ${version} (expected v${version})`;
  }
  return publish
    ? `publishing runs on a release tag, not on the ${ref.type} ${ref.name}`
    : undefined;
}

// The body of CHANGELOG.md's "## <version>" section, or undefined.
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === `## ${version}`);
  if (start === -1) return undefined;
  const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
  const body = lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join("\n")
    .trim();
  return body === "" ? undefined : body;
}
