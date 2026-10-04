// The version pins users copy from the manual: the CLI package and the
// container image. The release PR moves them to the new version
// (changelog.mjs version), and manual-pins.test.mjs fails when one drifts.
// The Action's pin is a commit SHA, known only once the release is tagged,
// and is not one of them.
import { readdirSync } from "node:fs";
import { join } from "node:path";

const VERSION = String.raw`\d+\.\d+\.\d+[\w.+-]*`;
const PINS = [
  new RegExp(String.raw`(@open-cr-agent\/[a-z0-9-]+@)(${VERSION})`, "g"),
  new RegExp(String.raw`(ghcr\.io\/jma49\/ocra:)(${VERSION})`, "g"),
];

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
