#!/usr/bin/env node
// Versioning and CHANGELOG.md; The release runbook is in the maintainers' private notes.
//
// Changesets decides the version and writes it (`changeset version`), but
// no changelog (`"changelog": false` in .changeset/config.json): its
// changelogs are per package and grouped by bump type, ours is one file for
// the packages released together, grouped by Keep a Changelog category. So
// `version` first asks changesets for the plan and moves the entries of the
// pending changesets into CHANGELOG.md, then has changesets apply the plan,
// which deletes them, then updates package-lock.json and moves the
// manual's version pins (lib/manual-pins.mjs). After the release is tagged,
// `action-pin` moves the Action's pin to the tag's commit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cutRelease, parseFragment, releaseNotes } from "./lib/changelog.mjs";
import { errorMessage } from "./lib/error-message.mjs";
import { actionPinFiles, bumpActionPins, bumpPins, manualPages } from "./lib/manual-pins.mjs";

const USAGE = `Usage:
  node scripts/changelog.mjs version          (npm run version-packages) version the packages from the
                                              pending changesets, with a CHANGELOG.md section for it
  node scripts/changelog.mjs notes <x.y.z>    print that version's section, the GitHub release notes
  node scripts/changelog.mjs action-pin <x.y.z>
                                              pin the Action to the commit of the tag v<x.y.z> in the
                                              manual, the README, the dogfood workflow and ocra init`;

const root = fileURLToPath(new URL("..", import.meta.url));
const changelogPath = join(root, "CHANGELOG.md");

/**
 * @param {string} message
 * @returns {never}
 */
function stop(message, code = 1) {
  console.error(message);
  process.exit(code);
}

// The release plan changesets would apply: `changeset status --output`.
/**
 * @returns {{
 *   releases: { type: string, newVersion: string }[],
 *   changesets: { id: string, summary: string }[],
 * }}
 */
function releasePlan() {
  const dir = mkdtempSync(join(tmpdir(), "ocra-changeset-"));
  const file = join(dir, "plan.json");
  const status = spawnSync("npx", ["--no-install", "changeset", "status", "--output", file], {
    cwd: root,
    encoding: "utf8",
  });
  const plan = status.status === 0 ? readFileSync(file, "utf8") : undefined;
  rmSync(dir, { recursive: true, force: true });
  if (!plan) stop(`changelog: changeset status failed:\n${status.stderr || status.stdout}`);
  return JSON.parse(plan);
}

// `npm run` exports a user-level allow-scripts setting as
// npm_config_allow_scripts, which npm 11 refuses in a project install.
/**
 * @param {string} command
 * @param {string[]} args
 */
function run(command, args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^npm_config_allow_scripts$/i.test(key)),
  );
  console.log(`\n$ ${command} ${args.join(" ")}`);
  if (spawnSync(command, args, { cwd: root, env, stdio: "inherit" }).status !== 0) {
    stop(`changelog: ${command} ${args[0]} failed; git restore . undoes this run's changes`);
  }
}

// The date as the committer's clock reads it, like the tag dates in git log.
function today() {
  const now = new Date();
  /** @param {number} n */
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function versionPackages() {
  const plan = releasePlan();
  const versions = new Set(plan.releases.filter((r) => r.type !== "none").map((r) => r.newVersion));
  if (versions.size !== 1) {
    stop(
      versions.size === 0
        ? "changelog: no changeset asks for a release; add one with npx changeset"
        : `changelog: the packages would get different versions: ${[...versions].join(", ")}`,
    );
  }
  const [version] = /** @type {[string]} */ ([...versions]);
  const fragments = plan.changesets.map((c) => ({
    id: c.id,
    ...parseFragment(c.summary, { prose: false }),
  }));
  const problems = fragments.flatMap((f) => f.problems.map((p) => `.changeset/${f.id}.md: ${p}`));
  if (problems.length > 0) stop(`changelog: ${problems.join("\n  ")}`);
  const date = today();
  let next;
  try {
    next = cutRelease(readFileSync(changelogPath, "utf8"), { version, date, fragments });
  } catch (error) {
    stop(`changelog: ${errorMessage(error)}`);
  }
  writeFileSync(changelogPath, next);
  console.log(`CHANGELOG.md has a section for ${version} (${date}).`);
  run("npx", ["--no-install", "changeset", "version"]);
  run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const bumped = manualPages(root).filter((path) => {
    const text = readFileSync(path, "utf8");
    const next = bumpPins(text, version);
    if (next !== text) writeFileSync(path, next);
    return next !== text;
  });
  console.log(`The manual's version pins name ${version} (${bumped.length} page(s) changed).`);
  console.log(
    `Bring docs/roadmap.md up to ${version} by hand: its milestones, and its header "as of <date> (${version} released)", which scripts/roadmap.test.mjs checks.`,
  );
  console.log(
    `\nEvery published package is now ${version}. Review the changes and open a pull request.`,
  );
}

/** @param {string} version */
function notes(version) {
  const body = releaseNotes(readFileSync(changelogPath, "utf8"), version);
  if (!body) stop(`changelog: CHANGELOG.md has no "## [${version}] - <date>" section`);
  process.stdout.write(`${body}\n`);
}

/** @param {string} version */
function actionPin(version) {
  const tag = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `v${version}^{commit}`],
    { cwd: root, encoding: "utf8" },
  );
  if (tag.status !== 0) stop(`changelog: no tag v${version} here; git fetch --tags first`);
  const commit = tag.stdout.trim();
  let changed;
  try {
    changed = actionPinFiles(root).filter((path) => {
      const text = readFileSync(path, "utf8");
      const next = bumpActionPins(text, commit, version);
      if (next !== text) writeFileSync(path, next);
      return next !== text;
    });
  } catch (error) {
    stop(`changelog: ${errorMessage(error)}`);
  }
  console.log(`The Action is pinned to v${version} (${commit}) in ${changed.length} file(s).`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "version" && args.length === 0) versionPackages();
else if (command === "notes" && args.length === 1) notes(/** @type {string} */ (args[0]));
else if (command === "action-pin" && args.length === 1) actionPin(/** @type {string} */ (args[0]));
else stop(USAGE, 2);
