#!/usr/bin/env node
// Release tooling for the workspace packages. docs/releasing.md is the
// runbook. The maintainer runs `publish`; .github/workflows/release.yml
// splits the same work into `pack`, which runs the build and the tests, and
// `upload`, which runs nothing but npm where a publish token can be minted.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atLeast,
  changelogSection,
  distTag,
  isVersion,
  lockstep,
  publishOrder,
  readWorkspaces,
  refProblem,
  tarballName,
  withVersion,
} from "./release-lib.mjs";

const USAGE = `Usage:
  node scripts/release.mjs version <x.y.z>           set one version on every package and the lockfile
  node scripts/release.mjs notes <x.y.z>             print that version's section of CHANGELOG.md
  node scripts/release.mjs publish                   dry run: every check, then npm publish --dry-run
  node scripts/release.mjs publish --publish         check, build and publish what the registry lacks
  node scripts/release.mjs pack <dir>                (CI) check, build and pack every package into <dir>
  node scripts/release.mjs upload <dir> [--publish]  (CI) publish the tarballs in <dir>; a dry run without --publish`;

// npm's trusted publishing (OIDC) needs this npm or newer.
const TRUSTED_PUBLISHING_NPM = "11.5.1";

const root = fileURLToPath(new URL("..", import.meta.url));
const ci = process.env.GITHUB_ACTIONS === "true";

function stop(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// Runs with the output shown; true when the command succeeded.
function step(command, args, cwd = root) {
  const where = cwd === root ? "" : `  (in ${relative(root, cwd)})`;
  console.log(`\n$ ${command} ${args.join(" ")}${where}`);
  return spawnSync(command, args, { cwd, stdio: "inherit" }).status === 0;
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: (result.stdout ?? "").trim(),
    err: (result.stderr ?? "").trim(),
  };
}

function readChangelog() {
  const path = join(root, "CHANGELOG.md");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// The shared version and the publish order; stops unless the packages are
// in lockstep.
function packages() {
  const workspaces = readWorkspaces(root);
  const { version, problems } = lockstep(workspaces);
  if (problems.length > 0) {
    stop(
      `release: the packages are not at one version:\n  ${problems.join("\n  ")}\n` +
        "Run node scripts/release.mjs version <x.y.z>.",
    );
  }
  return { version, order: publishOrder(workspaces) };
}

// Why this run must not publish. A strict run stops at the first reason; a
// dry run reports each one, carries on, and fails at the end.
function refusals(strict) {
  const reasons = [];
  const refuse = (reason) => {
    if (strict) stop(`release: not publishing: ${reason}`);
    reasons.push(reason);
    console.log(`--publish would refuse: ${reason}`);
  };
  return { reasons, refuse };
}

// The release commit has notes, is committed, and is on main.
function checkSource(version, refuse) {
  if (!changelogSection(readChangelog(), version)) {
    refuse(`CHANGELOG.md has no "## ${version}" section`);
  }
  const status = capture("git", ["status", "--porcelain", "--untracked-files=all"]);
  if (!status.ok || status.out !== "")
    refuse("the working tree has uncommitted or untracked files");
  const fetched = capture("git", ["fetch", "--quiet", "origin", "main"]);
  if (!fetched.ok) refuse(`git fetch origin main failed: ${fetched.err}`);
  else if (!capture("git", ["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"]).ok) {
    refuse("HEAD is not a commit on origin/main");
  }
}

// In CI: the ref matches the version, and npm is new enough for OIDC.
function checkCi(version, publishing, refuse) {
  if (!ci) return;
  const ref = { type: process.env.GITHUB_REF_TYPE, name: process.env.GITHUB_REF_NAME };
  const problem = refProblem(version, ref, publishing);
  if (problem) refuse(problem);
  const npm = capture("npm", ["--version"]).out;
  if (!atLeast(npm, TRUSTED_PUBLISHING_NPM)) {
    refuse(`npm ${npm} cannot use trusted publishing (needs ${TRUSTED_PUBLISHING_NPM} or newer)`);
  }
}

function build() {
  if (!step("npm", ["run", "verify"])) stop("release: npm run verify failed");
  if (!step("npm", ["run", "check:packages"])) stop("release: npm run check:packages failed");
}

// Packs each package into dir. Returns why it stopped, if it did.
function pack(list, version, dir) {
  mkdirSync(dir, { recursive: true });
  for (const w of list) {
    const packed = capture("npm", ["pack", "--json", "--pack-destination", dir], w.dir);
    const filename = packed.ok ? parseJson(packed.out)?.[0]?.filename : undefined;
    if (filename !== tarballName(w.json.name, version)) {
      return `release: packing ${w.json.name} failed:\n${packed.err || packed.out}`;
    }
    console.log(`packed ${filename}`);
  }
  return undefined;
}

// Whether the registry has this version. An answer other than the version
// or "not found" (network or registry errors) stops the run.
function published(name, version) {
  const view = capture("npm", ["view", `${name}@${version}`, "version", "--json"]);
  if (view.ok) return view.out !== "";
  if (/\bE404\b/.test(`${view.out}\n${view.err}`)) return false;
  return stop(`release: could not ask the registry about ${name}@${version}:\n${view.err}`);
}

function pending(order, version) {
  console.log("");
  const todo = order.filter((w) => !published(w.json.name, version));
  for (const w of order) {
    const state = todo.includes(w) ? "to publish" : "already on the registry, skipped";
    console.log(`${w.json.name}@${version}: ${state}`);
  }
  return todo;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The manifest inside a tarball. npm publishes the name and version written
// there, whatever the file is called, and the tarballs CI publishes were
// packed by another job.
function manifestOf(tarball) {
  const read = capture("tar", ["-xzOf", tarball, "package/package.json"]);
  return read.ok ? parseJson(read.out) : undefined;
}

// Publishes the tarballs in order. Returns why it stopped, if it did.
function upload(todo, version, dir, real) {
  const tag = distTag(version);
  for (const [i, w] of todo.entries()) {
    const tarball = join(dir, tarballName(w.json.name, version));
    const manifest = manifestOf(tarball);
    const args = ["publish", tarball, "--access", "public", "--tag", tag];
    if (!real) args.push("--dry-run");
    const problem =
      manifest?.name !== w.json.name || manifest?.version !== version
        ? `${tarball} does not hold ${w.json.name}@${version}`
        : !step("npm", args) && `publishing ${w.json.name}@${version} failed`;
    if (problem) {
      const done = todo.slice(0, i).map((p) => p.json.name);
      return (
        `release: ${problem}.` +
        (real && done.length > 0 ? ` Published in this run: ${done.join(", ")}.` : "") +
        " Fix the cause and run the same command again; versions already on the registry are skipped."
      );
    }
  }
  return undefined;
}

function setVersion(version) {
  if (!isVersion(version)) stop(USAGE, 2);
  for (const { dir, json } of withVersion(readWorkspaces(root), version)) {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(json, null, 2)}\n`);
  }
  if (!step("npm", ["install", "--package-lock-only", "--no-audit", "--no-fund"])) {
    stop("release: updating package-lock.json failed");
  }
  console.log(`\nEvery workspace package is now ${version}.`);
  if (!changelogSection(readChangelog(), version)) {
    console.log(`Add a "## ${version}" section to CHANGELOG.md before releasing.`);
  }
}

function printNotes(version) {
  if (!isVersion(version)) stop(USAGE, 2);
  const notes = changelogSection(readChangelog(), version);
  if (!notes) stop(`release: CHANGELOG.md has no "## ${version}" section`);
  process.stdout.write(`${notes}\n`);
}

function publishCommand(real) {
  const { version, order } = packages();
  const { reasons, refuse } = refusals(real);
  checkSource(version, refuse);
  checkCi(version, real, refuse);
  const todo = pending(order, version);
  if (todo.length > 0) {
    if (!ci) {
      const user = capture("npm", ["whoami"]);
      if (user.ok) console.log(`npm user: ${user.out}`);
      else refuse("npm is not logged in (run npm login)");
    }
    build();
    const dir = mkdtempSync(join(tmpdir(), "ocra-release-"));
    const failure = pack(todo, version, dir) ?? upload(todo, version, dir, real);
    rmSync(dir, { recursive: true, force: true });
    if (failure) stop(failure);
  }
  if (!real) {
    if (reasons.length > 0)
      stop(`\nDry run finished; --publish would refuse:\n  ${reasons.join("\n  ")}`);
    console.log(`\nDry run finished: --publish would publish ${todo.length} package(s).`);
    return;
  }
  const head = capture("git", ["rev-parse", "HEAD"]).out;
  console.log(`\nEvery package is on the registry at ${version} (from ${head}).`);
  if (!ci) {
    console.log(
      "Next, per docs/releasing.md: trusted publishing after the first release, then the GitHub release:\n" +
        `  node scripts/release.mjs notes ${version} | gh release create v${version} --target ${head} --title v${version} --notes-file -`,
    );
  }
}

function packCommand(dir) {
  const { version, order } = packages();
  const { refuse } = refusals(true);
  checkSource(version, refuse);
  // Whether this run publishes is for `upload` to check.
  checkCi(version, false, refuse);
  build();
  const failure = pack(order, version, resolve(dir));
  if (failure) stop(failure);
}

function uploadCommand(dir, real) {
  const { version, order } = packages();
  const { refuse } = refusals(true);
  checkCi(version, real, refuse);
  const absent = order.filter((w) => !existsSync(join(dir, tarballName(w.json.name, version))));
  if (absent.length > 0) {
    stop(`release: ${dir} has no tarball for ${absent.map((w) => w.json.name).join(", ")}`);
  }
  const todo = pending(order, version);
  const failure = upload(todo, version, resolve(dir), real);
  if (failure) stop(failure);
  console.log(
    real
      ? `\nEvery package is on the registry at ${version}.`
      : `\nDry run finished: --publish would publish ${todo.length} package(s).`,
  );
}

const [command, ...args] = process.argv.slice(2);
const publishFlag = args.at(-1) === "--publish";
if (command === "version" && args.length === 1) setVersion(args[0]);
else if (command === "notes" && args.length === 1) printNotes(args[0]);
else if (command === "publish" && args.length === (publishFlag ? 1 : 0))
  publishCommand(publishFlag);
else if (command === "pack" && args.length === 1 && !publishFlag) packCommand(args[0]);
else if (command === "upload" && args.length === (publishFlag ? 2 : 1) && args[0] !== "--publish") {
  uploadCommand(args[0], publishFlag);
} else stop(USAGE, 2);
