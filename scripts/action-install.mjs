#!/usr/bin/env node
// Installs the ocra the GitHub Action runs (action.yml): the published
// @open-cr-agent/cli at this checkout's version, with every dependency at the
// version this checkout's package-lock.json pins (scripts/pinned-lock.mjs),
// install scripts off, the registry's signatures verified, and each of ocra's
// own packages proven by its provenance to come from this repository's
// release workflow at the version's tag (scripts/provenance.mjs). It builds
// this checkout instead when that version is not on npm (a version bump not
// yet released), was published with other dependencies than this checkout
// declares or without that provenance, or does not install. Writes the CLI's
// entry point as the step output `main`, and why it built from source as
// `source`.
//
// Usage: node scripts/action-install.mjs [--from-source]
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinnedLockfile } from "./pinned-lock.mjs";
import { provenanceProblems } from "./provenance.mjs";
import { readWorkspaces } from "./release-lib.mjs";

const TARGET = "@open-cr-agent/cli";
const NPMJS = /^https:\/\/registry\.npmjs\.org\/?$/;
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

const root = fileURLToPath(new URL("..", import.meta.url));
const temp = process.env.RUNNER_TEMP ?? tmpdir();
// An npm cache of this install's own: packages and registry answers come
// from the registry, never from a cache an earlier step or a restored
// actions/cache left in ~/.npm.
const CACHE = ["--cache", join(temp, "ocra-npm-cache")];
// No install scripts: they would run with the job's secrets in the
// environment. The OpenCode binary is resolved without one.
const INSTALL_FLAGS = [...CACHE, "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
const started = Date.now();

// How to start npm: a .cmd shim on Windows, which Node starts only through a
// shell and then as one command line, with an argument holding a space (a
// runner under "C:\Program Files") quoted; a Windows path cannot hold the
// quote itself.
function npmCommand(args) {
  if (process.platform !== "win32") return { file: "npm", args, shell: false };
  const line = ["npm", ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" ");
  return { file: line, args: [], shell: true };
}

function npm(args, cwd, capture = false) {
  const command = npmCommand(args);
  const result = spawnSync(command.file, command.args, {
    cwd,
    shell: command.shell,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

function ready(main, how) {
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`ocra ${how} in ${seconds} s: ${main}`);
  output("main", main);
}

function fail(message) {
  console.log(`::error::${message}`);
  process.exit(1);
}

function fromSource() {
  if (!npm(["ci", "--prefix", root, ...INSTALL_FLAGS], root).ok) fail("npm ci failed");
  if (!npm(["run", "build", "--prefix", root], root).ok) fail("npm run build failed");
  ready(join(root, "packages", "cli", "dist", "main.js"), "built from source");
}

// The published manifest of name@version, or why there is none. Asked in
// parallel for every package: each npm view takes most of a second.
function published(name, version) {
  return new Promise((done) => {
    const command = npmCommand(["view", `${name}@${version}`, "--json", ...CACHE]);
    const child = spawn(command.file, command.args, {
      cwd: root,
      shell: command.shell,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", (error) =>
      done({ reason: `npm view failed: ${error.message}`, kind: "registry" }),
    );
    child.on("close", (status) => {
      const json = parseJson(out);
      if (status === 0 && json?.version === version) return done({ manifest: json });
      const code = json?.error?.code;
      done(
        code === "E404"
          ? { reason: `${name}@${version} is not on npm`, kind: "unpublished" }
          : {
              reason: `npm view ${name}@${version} failed${code ? ` (${code})` : ""}`,
              kind: "registry",
            },
      );
    });
  });
}

const sameDependencies = (a, b) =>
  DEPENDENCY_FIELDS.every(
    (field) =>
      JSON.stringify(Object.entries(a[field] ?? {}).sort()) ===
      JSON.stringify(Object.entries(b[field] ?? {}).sort()),
  );

// Installs the published packages into a directory of their own. Returns the
// entry point, or why this checkout should be built instead and whether that
// deserves a warning.
async function fromRegistry(workspaces, version) {
  const packages = workspaces.filter((w) => !w.json.private).map((w) => w.json);
  const answers = await Promise.all(packages.map((json) => published(json.name, json.version)));
  const dist = new Map();
  for (const [i, json] of packages.entries()) {
    const { manifest, reason, kind } = answers[i];
    if (!manifest) return { reason, kind };
    if (!sameDependencies(manifest, json)) {
      return {
        reason: `${json.name}@${json.version} on npm declares other dependencies`,
        kind: "dependencies",
      };
    }
    dist.set(json.name, manifest.dist ?? {});
  }

  let pinned;
  try {
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    pinned = pinnedLockfile({
      lock,
      root,
      workspaces,
      target: TARGET,
      integrity: (name) => dist.get(name)?.integrity,
      resolved: (name) => dist.get(name)?.tarball,
    });
  } catch (error) {
    return { reason: `no pinned install: ${error.message}`, warn: true, kind: "install" };
  }
  const dir = join(temp, "ocra-cli");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify(pinned.manifest, null, 2)}\n`);
  writeFileSync(join(dir, "package-lock.json"), `${JSON.stringify(pinned.lockfile, null, 2)}\n`);

  console.log(`Installing ${TARGET}@${version}, dependencies pinned by this ref's lockfile`);
  if (!npm(["ci", ...INSTALL_FLAGS], dir).ok) {
    return { reason: `npm ci of ${TARGET}@${version} failed`, warn: true, kind: "install" };
  }
  // Building this checkout instead would skip the check, so a bad signature
  // stops the run. A package without provenance from this repository's
  // release workflow may be genuine (0.1.0 was published by hand) or not;
  // this checkout is what that version should hold, so it is built instead.
  // Mirrors may not serve npm's keys or attestations; the lockfile's
  // integrity hashes still hold there.
  const registry = npm(["config", "get", "registry"], dir, true).out;
  if (NPMJS.test(registry)) {
    if (!npm(["audit", "signatures", ...CACHE], dir).ok) fail("npm audit signatures failed");
    const repository = workspaces.find((w) => w.json.name === TARGET)?.json.repository?.url;
    const problem = repository
      ? await provenanceProblems(
          packages.map((json) => ({
            name: json.name,
            version: json.version,
            dist: dist.get(json.name),
          })),
          { repository },
        )
      : `${TARGET} in this checkout names no repository`;
    if (problem) {
      rmSync(dir, { recursive: true, force: true });
      return { reason: problem, warn: true, kind: "provenance" };
    }
  } else {
    console.log(
      `::notice::Not verifying signatures or provenance: the registry is ${registry}, not npmjs.`,
    );
  }
  const cli = JSON.parse(readFileSync(join(dir, "node_modules", TARGET, "package.json"), "utf8"));
  return { main: join(dir, "node_modules", TARGET, cli.bin.ocra) };
}

async function install() {
  const workspaces = readWorkspaces(root);
  const version = workspaces.find((w) => w.json.name === TARGET)?.json.version;
  if (!version) fail(`${TARGET} is not in this checkout`);
  if (process.argv.includes("--from-source")) {
    console.log("Building ocra from source at this ref: --from-source was given.");
    return fromSource();
  }
  const result = await fromRegistry(workspaces, version);
  if (result.main) return ready(result.main, `${version} installed from npm`);
  console.log(
    `::${result.warn ? "warning" : "notice"}::Building ocra from source at this ref: ${result.reason}.`,
  );
  // Why, for the caller: unpublished, dependencies, registry, install or provenance.
  output("source", result.kind);
  fromSource();
}

await install();
