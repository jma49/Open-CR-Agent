import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

const workspace = (name, json = {}) => ({
  dir: `/repo/packages/${name}`,
  json: { name: `@x/${name}`, version: "1.0.0", ...json },
});

const names = (workspaces) => workspaces.map((w) => w.json.name);

describe("lockstep", () => {
  it("accepts one version with internal dependencies at exactly that version", () => {
    const result = lockstep([
      workspace("core", { dependencies: { zod: "^4.0.0" } }),
      workspace("cli", { dependencies: { "@x/core": "1.0.0" } }),
    ]);
    expect(result).toEqual({ version: "1.0.0", problems: [] });
  });

  it("names a package at another version and an internal dependency left behind", () => {
    const { problems } = lockstep([
      workspace("core"),
      workspace("cli", { version: "1.0.1", devDependencies: { "@x/core": "^1.0.0" } }),
    ]);
    expect(problems).toEqual([
      "@x/cli is 1.0.1, not 1.0.0",
      "@x/cli depends on @x/core@^1.0.0, not 1.0.0",
    ]);
  });
});

describe("withVersion", () => {
  it("sets the version and every internal dependency, and nothing else", () => {
    const before = [
      workspace("core", { dependencies: { zod: "^4.0.0" } }),
      workspace("cli", { dependencies: { "@x/core": "1.0.0", zod: "^4.0.0" } }),
    ];
    const after = withVersion(before, "1.1.0");
    expect(after.map((w) => w.json)).toEqual([
      { name: "@x/core", version: "1.1.0", dependencies: { zod: "^4.0.0" } },
      { name: "@x/cli", version: "1.1.0", dependencies: { "@x/core": "1.1.0", zod: "^4.0.0" } },
    ]);
    expect(lockstep(after).problems).toEqual([]);
    expect(before[1]?.json.dependencies["@x/core"]).toBe("1.0.0");
  });
});

describe("publishOrder", () => {
  it("puts every package after the packages it needs and leaves private ones out", () => {
    const order = publishOrder([
      workspace("cli", { dependencies: { "@x/core": "1.0.0", "@x/vcs": "1.0.0" } }),
      workspace("core"),
      workspace("eval", { private: true, dependencies: { "@x/cli": "1.0.0" } }),
      workspace("vcs", { peerDependencies: { "@x/core": "1.0.0" } }),
    ]);
    expect(names(order)).toEqual(["@x/core", "@x/vcs", "@x/cli"]);
  });

  it("refuses a published package that needs a private one, and a cycle", () => {
    expect(() =>
      publishOrder([
        workspace("cli", { dependencies: { "@x/eval": "1.0.0" } }),
        workspace("eval", { private: true }),
      ]),
    ).toThrow("@x/cli needs @x/eval, which is private");
    expect(() =>
      publishOrder([
        workspace("a", { dependencies: { "@x/b": "1.0.0" } }),
        workspace("b", { dependencies: { "@x/a": "1.0.0" } }),
      ]),
    ).toThrow("dependency cycle");
  });
});

describe("refProblem", () => {
  it("publishes only from the tag of the package version", () => {
    expect(refProblem("0.1.0", { type: "tag", name: "v0.1.0" }, true)).toBeUndefined();
    expect(refProblem("0.1.0", { type: "tag", name: "v0.1.1" }, true)).toContain(
      "does not match the package version 0.1.0",
    );
    expect(refProblem("0.1.0", { type: "tag", name: "v0.1.1" }, false)).toBeDefined();
    expect(refProblem("0.1.0", { type: "branch", name: "main" }, true)).toContain(
      "publishing runs on a release tag",
    );
    expect(refProblem("0.1.0", { type: "branch", name: "main" }, false)).toBeUndefined();
  });
});

describe("changelogSection", () => {
  const changelog =
    "# Changelog\n\n## 0.2.0\n\n- two\n\n## 0.1.0\n\nFirst.\n\n### Added\n\n- one\n";

  it("returns one version's section without its heading", () => {
    expect(changelogSection(changelog, "0.2.0")).toBe("- two");
    expect(changelogSection(changelog, "0.1.0")).toBe("First.\n\n### Added\n\n- one");
  });

  it("finds no section for another version, a prefix of one, or an empty one", () => {
    expect(changelogSection(changelog, "0.3.0")).toBeUndefined();
    expect(changelogSection(changelog, "0.1")).toBeUndefined();
    expect(changelogSection("## 0.4.0\n\n## 0.3.0\n- x\n", "0.4.0")).toBeUndefined();
  });
});

describe("versions", () => {
  it("accepts x.y.z with an optional prerelease and nothing else", () => {
    for (const ok of ["0.1.0", "10.20.30", "1.0.0-rc.1", "1.0.0-beta-2"]) {
      expect(isVersion(ok)).toBe(true);
    }
    for (const bad of [undefined, "", "v0.1.0", "0.1", "0.1.0+build", "0.1.0-", "0.1.0\n"]) {
      expect(isVersion(bad)).toBe(false);
    }
  });

  it("compares the x.y.z part numerically", () => {
    expect(atLeast("11.19.0", "11.5.1")).toBe(true);
    expect(atLeast("11.5.1", "11.5.1")).toBe(true);
    expect(atLeast("11.5.0", "11.5.1")).toBe(false);
    expect(atLeast("10.9.9", "11.5.1")).toBe(false);
    expect(atLeast("12.0.0-pre", "11.5.1")).toBe(true);
    expect(atLeast("", "11.5.1")).toBe(false);
    expect(atLeast("npm", "11.5.1")).toBe(false);
  });

  it("keeps prereleases off the latest tag", () => {
    expect(distTag("0.1.0")).toBe("latest");
    expect(distTag("0.2.0-rc.1")).toBe("next");
  });

  it("names tarballs as npm pack does", () => {
    expect(tarballName("@open-cr-agent/core", "0.1.0")).toBe("open-cr-agent-core-0.1.0.tgz");
    expect(tarballName("plain", "1.0.0-rc.1")).toBe("plain-1.0.0-rc.1.tgz");
  });
});

describe("readWorkspaces", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the directories under packages/ that have a manifest, in name order", () => {
    const root = mkdtempSync(join(tmpdir(), "ocra-release-"));
    dirs.push(root);
    for (const name of ["b", "a", "empty"])
      mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(join(root, "packages", "a", "package.json"), '{ "name": "a" }');
    writeFileSync(join(root, "packages", "b", "package.json"), '{ "name": "b" }');
    writeFileSync(join(root, "packages", ".DS_Store"), "");
    expect(readWorkspaces(root).map((w) => w.json.name)).toEqual(["a", "b"]);
  });

  it("finds this repository's packages in lockstep, publishable in dependency order", () => {
    const workspaces = readWorkspaces(fileURLToPath(new URL("..", import.meta.url)));
    expect(lockstep(workspaces).problems).toEqual([]);
    expect(names(publishOrder(workspaces))).toEqual([
      "@open-cr-agent/core",
      "@open-cr-agent/runtime-opencode",
      "@open-cr-agent/vcs-platform",
      "@open-cr-agent/vcs-github",
      "@open-cr-agent/vcs-local",
      "@open-cr-agent/cli",
      "@open-cr-agent/vcs-gitlab",
    ]);
  });
});
