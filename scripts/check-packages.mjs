#!/usr/bin/env node
// Packs every publishable workspace, installs the tarballs into an empty
// project as a user would, and runs the installed ocra: --version, and a
// free --plan review of a scratch repository. Then installs them as the
// GitHub Action does, with the dependency versions this lockfile pins
// (scripts/pinned-lock.mjs). Catches missing files, undeclared dependencies,
// broken bin entries and a lockfile the Action cannot pin before anything
// is published. Each tarball is also linted as published: publint (the
// package.json against the files) and attw (the types resolve under Node's
// ESM and bundler resolution; the packages are ESM only). The source
// condition every entry starts with (@open-cr-agent/source, for the tests)
// names files that are not published; both tools skip conditions they do not
// know, and so does every consumer. Last, installs them as the Action does
// with `opencode: false` (--omit=optional): OpenCode is left out, and ocra
// says so with exit code 2 when the configured runtime needs it. Needs
// network access for third-party dependencies, and the root devDependencies
// (npm ci) for the linters.
//
// Usage: node scripts/check-packages.mjs [--tarballs <dir>]
// With --tarballs, checks the tarballs in <dir> (packed by the release
// workflow's pack job) instead of packing this checkout.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pinnedLockfile } from "./pinned-lock.mjs";
import { readWorkspaces, tarballName } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd, args, cwd, extra = {}) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...extra,
  });

const packages = readWorkspaces(root).filter((p) => !p.json.private);
const flag = process.argv.indexOf("--tarballs");
const given = flag === -1 ? undefined : resolve(process.argv[flag + 1] ?? ".");

// The runtime must find the OpenCode binary in an installed layout, not
// only inside this monorepo.
function findsOpencode(dir) {
  const binaryModule = join(
    dir,
    "node_modules",
    "@open-cr-agent",
    "runtime-opencode",
    "dist",
    "binary.js",
  );
  const binary = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { resolveOpencodeBinary } = await import(${JSON.stringify(pathToFileURL(binaryModule).href)}); console.log(resolveOpencodeBinary({}));`,
    ],
    dir,
  ).trim();
  run(binary, ["--version"], dir);
  console.log(`installed runtime finds OpenCode at ${binary.replace(realpathSync(dir), ".")}`);
}

// What an install takes on disk, as du counts it.
const megabytes = (dir) => `${(run("du", ["-sk", dir], dir).split("\t")[0] / 1024) | 0} MB`;

// The tarball of a workspace package: packed from this checkout, or the
// one given for its name and version.
function tarballFor(p, work) {
  if (!given) {
    const [info] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], p.dir));
    return join(work, info.filename);
  }
  const tarball = join(given, tarballName(p.json.name, p.json.version));
  if (!existsSync(tarball)) {
    throw new Error(`${given} has no tarball for ${p.json.name}@${p.json.version}`);
  }
  return tarball;
}

// publint and attw on a tarball; they print what they find.
function lint(tarball, work) {
  const bin = (name) => join(root, "node_modules", ".bin", name);
  run(bin("publint"), ["run", tarball, "--strict"], work);
  run(bin("attw"), [tarball, "--profile", "esm-only", "--format", "ascii", "--no-emoji"], work);
}

// Paths inside a tarball, relative to the package root.
const filesIn = (tarball, work) =>
  run("tar", ["-tzf", tarball], work)
    .split("\n")
    .filter((f) => f !== "")
    .map((f) => f.replace(/^package\//, ""));

const work = mkdtempSync(join(tmpdir(), "ocra-pack-"));
try {
  const tarballs = packages.map((p) => {
    const tarball = tarballFor(p, work);
    const files = filesIn(tarball, work);
    if (!files.some((f) => f.startsWith("dist/")))
      throw new Error(`${p.json.name} packs no dist/ files`);
    if (
      files.some((f) => f.endsWith(".test.js") || f.includes(".fakes.") || f.startsWith("src/"))
    ) {
      throw new Error(`${p.json.name} packs sources or tests`);
    }
    // The maps would point at src/, which is not published.
    if (files.some((f) => f.endsWith(".map"))) throw new Error(`${p.json.name} packs source maps`);
    for (const required of ["README.md", "LICENSE"]) {
      if (!files.includes(required)) throw new Error(`${p.json.name} packs no ${required}`);
    }
    try {
      lint(tarball, work);
    } catch (error) {
      throw new Error(`${p.json.name} fails publint or attw:\n${error.stdout ?? error.message}`);
    }
    console.log(
      `${given ? "checking" : "packed"} ${basename(tarball)} (${files.length} files, ${(statSync(tarball).size / 1024).toFixed(0)} kB), publint and attw pass`,
    );
    return tarball;
  });

  const app = join(work, "app");
  run("mkdir", ["-p", app], work);
  writeFileSync(join(app, "package.json"), '{ "name": "pack-check", "private": true }\n');
  // A default install, as users run it: the OpenCode platform binary comes as
  // an optional dependency (with --omit=optional, ocra cannot find it).
  // `npm run` exports a user-level allow-scripts setting as
  // npm_config_allow_scripts, which npm 11 refuses in a project install.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)),
  );
  run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], app, {
    env,
  });
  const ocra = join(app, "node_modules", ".bin", "ocra");

  const version = run(ocra, ["--version"], app).trim();
  const expected = JSON.parse(
    readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
  ).version;
  if (version !== expected)
    throw new Error(`installed ocra reports ${version}, expected ${expected}`);

  findsOpencode(app);

  const repo = join(work, "repo");
  run("mkdir", ["-p", repo], work);
  const git = (...args) => run("git", args, repo);
  git("init", "-q");
  git(
    "-c",
    "user.email=p@example.com",
    "-c",
    "user.name=P",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  writeFileSync(join(repo, "app.ts"), "export const retries = -1;\n");
  const plan = run(ocra, ["review", "--plan"], repo);
  if (!plan.includes("Review tasks: 1")) throw new Error(`unexpected --plan output:\n${plan}`);
  console.log(`installed ocra ${version} runs: --version and review --plan`);

  const pinned = join(work, "pinned");
  mkdirSync(pinned);
  const tarballOf = new Map(packages.map((p, i) => [p.json.name, tarballs[i]]));
  const { manifest, lockfile } = pinnedLockfile({
    lock: JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
    root,
    workspaces: readWorkspaces(root),
    target: "@open-cr-agent/cli",
    integrity: (name) =>
      `sha512-${createHash("sha512")
        .update(readFileSync(tarballOf.get(name)))
        .digest("base64")}`,
    resolved: (name) => `file:${tarballOf.get(name)}`,
  });
  writeFileSync(join(pinned, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(pinned, "package-lock.json"), JSON.stringify(lockfile));
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], pinned, {
    env,
  });
  const main = join(pinned, "node_modules", "@open-cr-agent", "cli", "dist", "main.js");
  const pinnedVersion = run(process.execPath, [main, "--version"], pinned).trim();
  if (pinnedVersion !== expected) {
    throw new Error(`the pinned install reports ${pinnedVersion}, expected ${expected}`);
  }
  findsOpencode(pinned);
  console.log(
    `installed ocra ${pinnedVersion} as the Action does, pinned by package-lock.json (${megabytes(pinned)})`,
  );

  const lean = join(work, "lean");
  mkdirSync(lean);
  writeFileSync(join(lean, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(lean, "package-lock.json"), JSON.stringify(lockfile));
  run(
    "npm",
    ["ci", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    lean,
    { env },
  );
  for (const left of ["@open-cr-agent/runtime-opencode", "opencode-ai"]) {
    if (existsSync(join(lean, "node_modules", left))) {
      throw new Error(`--omit=optional still installed ${left}`);
    }
  }
  const leanMain = join(lean, "node_modules", "@open-cr-agent", "cli", "dist", "main.js");
  const missing = spawnSync(process.execPath, [leanMain, "review"], {
    cwd: repo,
    encoding: "utf8",
    env,
  });
  if (
    missing.status !== 2 ||
    !missing.stderr.includes("needs @open-cr-agent/runtime-opencode, which is not installed")
  ) {
    throw new Error(
      `ocra without OpenCode exited ${missing.status}:\n${missing.stdout}${missing.stderr}`,
    );
  }
  const leanPlan = run(process.execPath, [leanMain, "review", "--plan"], repo);
  if (!leanPlan.includes("Review tasks: 1"))
    throw new Error(`unexpected --plan output:\n${leanPlan}`);
  console.log(
    `installed ocra without OpenCode (${megabytes(lean)}): review --plan runs, review explains what is missing`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
