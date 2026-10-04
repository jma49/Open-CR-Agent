import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lockstep, readWorkspaces } from "./release-lib.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manual = join(root, "docs", "manual");

// Users copy the manual's install lines as they are, so its npm and image
// pins move with every release: the release PR that bumps the packages
// bumps these in the same commit. The Action's pin is a commit SHA, known
// only once the release is tagged, and is updated after it. A prerelease
// leaves the manual on the last stable release.
const PINS = [
  /@open-cr-agent\/[a-z0-9-]+@(\d+\.\d+\.\d+[\w.+-]*)/g,
  /ghcr\.io\/jma49\/ocra:(\d+\.\d+\.\d+[\w.+-]*)/g,
];

function pages(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pages(path);
    return entry.name.endsWith(".mdx") ? [path] : [];
  });
}

function pins() {
  return pages(manual).flatMap((path) => {
    const text = readFileSync(path, "utf8");
    return PINS.flatMap((pattern) =>
      [...text.matchAll(pattern)].map((match) => ({
        where: `${relative(root, path)}:${text.slice(0, match.index).split("\n").length}`,
        pin: match[0],
        version: match[1],
      })),
    );
  });
}

describe("version pins in the manual", () => {
  const { version } = lockstep(readWorkspaces(root));
  const found = pins();

  it("are found in both languages", () => {
    expect(found.some((p) => p.where.startsWith("docs/manual/en/"))).toBe(true);
    expect(found.some((p) => p.where.startsWith("docs/manual/zh/"))).toBe(true);
  });

  it.skipIf(version.includes("-"))(`all name the packages' version, ${version}`, () => {
    const stale = found.filter((p) => p.version !== version).map((p) => `${p.where} ${p.pin}`);
    expect(stale).toEqual([]);
  });
});
