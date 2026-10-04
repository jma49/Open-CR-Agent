// The parts of scripts/release.mjs that need no git, npm or network, so
// they can be tested.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEPENDENCY_FIELDS = /** @type {const} */ ([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * @typedef {{
 *   name: string,
 *   version: string,
 *   private?: boolean,
 *   exports?: Record<string, unknown>,
 *   bin?: Record<string, string>,
 *   files?: string[],
 *   engines?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 *   optionalDependencies?: Record<string, string>,
 *   [field: string]: unknown,
 * }} PackageJson
 * @typedef {{ dir: string, json: PackageJson }} Workspace
 */

// Every packages/* directory with a package.json, sorted by directory name.
/**
 * @param {string} root
 * @returns {Workspace[]}
 */
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

// The published packages are released together at one version (the `fixed`
// group in .changeset/config.json) and every workspace package depends on
// them at exactly that version, so a published cli never pairs with a core
// from another release. Private packages keep a version of their own.
/** @param {Workspace[]} workspaces */
export function lockstep(workspaces) {
  const published = workspaces.filter((w) => !w.json.private);
  const version = published[0]?.json.version;
  const names = new Set(published.map((w) => w.json.name));
  const problems = [];
  for (const { json } of published) {
    if (json.version !== version) problems.push(`${json.name} is ${json.version}, not ${version}`);
  }
  for (const { json } of workspaces) {
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

// The packages to publish, each after the workspace packages it needs at
// install time.
/** @param {Workspace[]} workspaces */
export function publishOrder(workspaces) {
  const byName = new Map(workspaces.map((w) => [w.json.name, w]));
  /** @type {Workspace[]} */
  const order = [];
  const visiting = new Set();
  /** @param {Workspace} w */
  const visit = (w) => {
    if (order.includes(w)) return;
    if (visiting.has(w)) throw new Error(`dependency cycle through ${w.json.name}`);
    visiting.add(w);
    const needs = /** @type {const} */ ([
      "dependencies",
      "peerDependencies",
      "optionalDependencies",
    ]).flatMap((field) => Object.keys(w.json[field] ?? {}));
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
/**
 * @param {string | undefined} version
 * @param {string} minimum
 */
export function atLeast(version, minimum) {
  /** @param {string | undefined} v */
  const parse = (v) => (v ?? "").split("-")[0]?.split(".").map(Number) ?? [];
  const [have, need] = [parse(version), parse(minimum)];
  if (have.length !== 3 || have.some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) {
    const [a, b] = [/** @type {number} */ (have[i]), need[i]];
    if (a !== b) return b !== undefined && a > b;
  }
  return true;
}

// A prerelease must not become what `npm install` picks by default.
/** @param {string} version */
export function distTag(version) {
  return version.includes("-") ? "next" : "latest";
}

// The file name `npm pack` gives a package.
/**
 * @param {string} name
 * @param {string} version
 */
export function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

// Why a CI run must not publish from this ref, or undefined. Publishing
// from CI runs on the release tag; a dry run may run on a branch.
/**
 * @param {string} version
 * @param {{ type: string | undefined, name: string | undefined }} ref
 * @param {boolean} publish
 */
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

// The digests `pack` reported, as a map from file name to "sha512-<base64>",
// or undefined when the text is not one.
/**
 * @param {string} text
 * @returns {Record<string, string> | undefined}
 */
export function parseDigests(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entries = Object.entries(parsed);
  const valid = entries.every(
    ([, digest]) => typeof digest === "string" && /^sha512-[A-Za-z0-9+/]+=*$/.test(digest),
  );
  return entries.length > 0 && valid ? parsed : undefined;
}

// Why the tarballs about to be published are not the ones `pack` made, or
// undefined. Both maps go from file name to digest.
/**
 * @param {Record<string, string>} expected
 * @param {Record<string, string>} actual
 */
export function digestProblem(expected, actual) {
  const problems = Object.entries(actual).flatMap(([file, digest]) => {
    if (expected[file] === undefined) return [`${file} is not one pack made`];
    return expected[file] === digest ? [] : [`${file} changed since pack made it`];
  });
  return problems.length > 0 ? problems.join("; ") : undefined;
}
