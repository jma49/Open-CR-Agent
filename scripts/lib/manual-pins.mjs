// The version pins users copy from the manual: the CLI package and the
// container image. The release PR moves them to the new version
// (scripts/changelog.mjs version), and manual-pins.test.mjs fails when one drifts.
// The Action's pin is a commit SHA, known only once the release is tagged:
// after the release, `scripts/changelog.mjs action-pin <version>` moves it
// everywhere it is written, the workflow ocra init writes included, and
// manual-pins.test.mjs fails when two of them differ.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSION = String.raw`\d+\.\d+\.\d+[\w.+-]*`;
const PINS = [
  new RegExp(String.raw`(@open-cr-agent\/[a-z0-9-]+@)(${VERSION})`, "g"),
  new RegExp(String.raw`(ghcr\.io\/jma49\/ocra:)(${VERSION})`, "g"),
];

const ACTION_PIN = new RegExp(
  String.raw`(jma49\/Open-CR-Agent@)([0-9a-f]{40}|<commit>) # v(${VERSION})`,
  "g",
);

/** Where ocra init's workflow takes the Action's pin from. */
export const ACTION_TEMPLATE = "packages/cli/src/commands/init/workflow.ts";

/**
 * The manual's pages, under docs/manual.
 * @param {string} root
 */
export function manualPages(root) {
  /**
   * @param {string} dir
   * @returns {string[]}
   */
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".mdx") ? [path] : [];
    });
  return walk(join(root, "docs", "manual"));
}

/**
 * Each pin in a page: the text, its version and its line.
 * @param {string} text
 */
export function pinsIn(text) {
  return PINS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => ({
      pin: match[0],
      version: match[2],
      line: text.slice(0, match.index).split("\n").length,
    })),
  );
}

/**
 * The page with every pin moved to version; a prerelease leaves it on the last stable one.
 * @param {string} text
 * @param {string} version
 */
export function bumpPins(text, version) {
  if (version.includes("-")) return text;
  return PINS.reduce((out, pattern) => out.replace(pattern, `$1${version}`), text);
}

/**
 * Every file that pins the Action: the manual, the README, the dogfood
 * workflow, and the template of ocra init with the workflows it writes,
 * kept for actionlint.
 * @param {string} root
 */
export function actionPinFiles(root) {
  const written = join(root, dirname(ACTION_TEMPLATE), "__snapshots__");
  return [
    ...manualPages(root),
    join(root, "README.md"),
    join(root, ".github", "workflows", "ocra-dogfood.yml"),
    join(root, ACTION_TEMPLATE),
    ...readdirSync(written).map((name) => join(written, name)),
  ];
}

/**
 * Each Action pin in a text: its commit (or the placeholder <commit>), its version and its line.
 * @param {string} text
 */
export function actionPinsIn(text) {
  return [...text.matchAll(ACTION_PIN)].map((match) => ({
    commit: /** @type {string} */ (match[2]),
    version: /** @type {string} */ (match[3]),
    line: text.slice(0, match.index).split("\n").length,
  }));
}

/**
 * The text with every Action pin on commit and its version comment on version;
 * a placeholder <commit> stays one.
 * @param {string} text
 * @param {string} commit
 * @param {string} version
 */
export function bumpActionPins(text, commit, version) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit id: ${commit}`);
  if (!new RegExp(`^${VERSION}$`).test(version)) throw new Error(`not a version: ${version}`);
  return text.replace(
    ACTION_PIN,
    (_, prefix, old) => `${prefix}${old === "<commit>" ? old : commit} # v${version}`,
  );
}
