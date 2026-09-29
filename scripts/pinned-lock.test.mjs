import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { lookupPaths, pinnedLockfile, registryUrl } from "./pinned-lock.mjs";
import { readWorkspaces } from "./release-lib.mjs";

const workspace = (name, json = {}) => ({
  dir: `/repo/packages/${name}`,
  json: { name: `@x/${name}`, version: "1.0.0", ...json },
});

const entry = (version, extra = {}) => ({
  version,
  resolved: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`,
  integrity: `sha512-${version}`,
  ...extra,
});

// A repository whose cli needs core, and whose lockfile hoists what it can.
function repository(packages = {}) {
  const workspaces = [
    workspace("core", { dependencies: { left: "^1.0.0" } }),
    workspace("cli", { dependencies: { "@x/core": "1.0.0", right: "^2.0.0" } }),
    workspace("eval", { private: true, dependencies: { "@x/cli": "1.0.0", bench: "^1.0.0" } }),
  ];
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { name: "repo", workspaces: ["packages/*"], devDependencies: { tool: "^1.0.0" } },
      "node_modules/@x/cli": { resolved: "packages/cli", link: true },
      "node_modules/@x/core": { resolved: "packages/core", link: true },
      "node_modules/@x/eval": { resolved: "packages/eval", link: true },
      "node_modules/bench": entry("1.0.0", { dev: true }),
      "node_modules/left": entry("1.2.0", {
        dependencies: { shared: "^1.0.0" },
        optionalDependencies: { "plat-a": "1.2.0", "plat-b": "1.2.0" },
      }),
      "node_modules/plat-a": entry("1.2.0", { optional: true, os: ["darwin"] }),
      "node_modules/plat-b": entry("1.2.0", { optional: true, os: ["linux"], libc: ["musl"] }),
      "node_modules/right": entry("2.0.0", { dependencies: { shared: "^2.0.0" } }),
      "node_modules/right/node_modules/shared": entry("2.1.0"),
      "node_modules/shared": entry("1.5.0"),
      "node_modules/tool": entry("1.0.0", { dev: true }),
      "packages/cli": { name: "@x/cli", version: "1.0.0" },
      "packages/core": { name: "@x/core", version: "1.0.0" },
      "packages/eval": { name: "@x/eval", version: "1.0.0" },
      ...packages,
    },
  };
  return { lock, workspaces };
}

const build = (repo, target = "@x/cli") =>
  pinnedLockfile({
    ...repo,
    root: "/repo",
    target,
    integrity: (name) => `sha512-tarball-of-${name}`,
  });

describe("lookupPaths", () => {
  it("walks from a package's own node_modules up to the root", () => {
    expect(lookupPaths("node_modules/a/node_modules/@s/b", "c")).toEqual([
      "node_modules/a/node_modules/@s/b/node_modules/c",
      "node_modules/a/node_modules/c",
      "node_modules/c",
    ]);
    expect(lookupPaths("packages/cli", "c")).toEqual([
      "packages/cli/node_modules/c",
      "node_modules/c",
    ]);
    expect(lookupPaths("", "@s/c")).toEqual(["node_modules/@s/c"]);
  });
});

describe("pinnedLockfile", () => {
  it("pins what the target needs, where the repository placed it, and nothing else", () => {
    const { manifest, lockfile } = build(repository());
    expect(manifest).toEqual({
      name: "ocra-install",
      private: true,
      dependencies: { "@x/cli": "1.0.0" },
    });
    expect(Object.keys(lockfile.packages)).toEqual([
      "",
      "node_modules/@x/cli",
      "node_modules/@x/core",
      "node_modules/left",
      "node_modules/plat-a",
      "node_modules/plat-b",
      "node_modules/right",
      "node_modules/right/node_modules/shared",
      "node_modules/shared",
    ]);
    expect(lockfile.packages[""]).toEqual({
      name: "ocra-install",
      dependencies: { "@x/cli": "1.0.0" },
    });
    expect(lockfile.packages["node_modules/right/node_modules/shared"].version).toBe("2.1.0");
    expect(lockfile.packages["node_modules/shared"].version).toBe("1.5.0");
  });

  it("installs workspace packages from their published tarballs", () => {
    const { lockfile } = build(repository());
    expect(lockfile.packages["node_modules/@x/core"]).toEqual({
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/@x/core/-/core-1.0.0.tgz",
      integrity: "sha512-tarball-of-@x/core",
      dependencies: { left: "^1.0.0" },
    });
    expect(registryUrl("left", "1.2.0")).toBe("https://registry.npmjs.org/left/-/left-1.2.0.tgz");
  });

  it("keeps platform packages optional with their platform fields, so npm skips the others", () => {
    const { lockfile } = build(repository());
    expect(lockfile.packages["node_modules/plat-b"]).toMatchObject({
      optional: true,
      os: ["linux"],
      libc: ["musl"],
    });
    expect(lockfile.packages["node_modules/left"].optional).toBeUndefined();
  });

  it("makes what an optional package needs optional too, and tolerates its gaps", () => {
    const { lockfile } = build(
      repository({
        "node_modules/plat-a": entry("1.2.0", {
          optional: true,
          os: ["darwin"],
          dependencies: { helper: "^1.0.0", gone: "^1.0.0" },
        }),
        "node_modules/helper": entry("1.0.0"),
      }),
    );
    expect(lockfile.packages["node_modules/helper"].optional).toBe(true);
    expect(lockfile.packages["node_modules/gone"]).toBeUndefined();
  });

  it("drops the repository's dev flags, and a package reached any required way is required", () => {
    const { lockfile } = build(
      repository({
        "node_modules/right": entry("2.0.0", {
          dev: true,
          dependencies: { shared: "^2.0.0" },
          optionalDependencies: { left: "^1.0.0" },
        }),
      }),
    );
    expect(lockfile.packages["node_modules/right"].dev).toBeUndefined();
    expect(lockfile.packages["node_modules/left"].optional).toBeUndefined();
  });

  it("marks what only a peer dependency reaches as peer, down its own dependencies", () => {
    const { lockfile } = build(
      repository({
        "node_modules/right": entry("2.0.0", {
          peerDependencies: { host: "^1.0.0", maybe: "^1.0.0" },
          peerDependenciesMeta: { maybe: { optional: true } },
        }),
        "node_modules/host": entry("1.0.0", {
          dependencies: { shared: "^1.0.0", "host-dep": "^1.0.0" },
        }),
        "node_modules/host-dep": entry("1.0.0"),
        "node_modules/maybe": entry("1.0.0"),
      }),
    );
    expect(lockfile.packages["node_modules/host"].peer).toBe(true);
    expect(lockfile.packages["node_modules/host-dep"].peer).toBe(true);
    // shared is also a regular dependency of left.
    expect(lockfile.packages["node_modules/shared"].peer).toBeUndefined();
    // An optional peer is installed only if something else needs it.
    expect(lockfile.packages["node_modules/maybe"]).toBeUndefined();
  });

  it("nests what the repository nests under a workspace package", () => {
    const { lockfile } = build(repository({ "packages/core/node_modules/left": entry("0.9.0") }));
    expect(lockfile.packages["node_modules/@x/core/node_modules/left"].version).toBe("0.9.0");
    expect(lockfile.packages["node_modules/left"]).toBeUndefined();
  });

  it("refuses a lockfile that cannot pin the target", () => {
    const missing = repository();
    delete missing.lock.packages["node_modules/shared"];
    expect(() => build(missing)).toThrow("package-lock.json has no shared for node_modules/left");

    const unpinned = repository({ "node_modules/right": { version: "2.0.0" } });
    expect(() => build(unpinned)).toThrow(
      "node_modules/right has no version, resolved URL or integrity",
    );

    expect(() => build({ ...repository(), lock: { lockfileVersion: 2 } })).toThrow(
      "lockfile version 2",
    );
    const needsPrivate = repository();
    needsPrivate.workspaces[1].json.dependencies["@x/eval"] = "1.0.0";
    expect(() => build(needsPrivate)).toThrow("@x/cli needs @x/eval, which is private");
  });

  it("refuses two packages that would install at the same path", () => {
    // right needs an older, published core; the cli links the workspace one.
    const repo = repository({
      "node_modules/@x/core": entry("0.9.0"),
      "packages/cli/node_modules/@x/core": { resolved: "packages/core", link: true },
      "node_modules/right": entry("2.0.0", { dependencies: { "@x/core": "^0.9.0" } }),
    });
    expect(() => build(repo)).toThrow(
      "node_modules/@x/core and packages/core would both install at node_modules/@x/core",
    );
  });

  it("pins the published CLI from this repository's lockfile", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
    const { lockfile } = pinnedLockfile({
      lock,
      root,
      workspaces: readWorkspaces(root),
      target: "@open-cr-agent/cli",
      integrity: (name) => `sha512-${name}`,
    });
    const paths = Object.keys(lockfile.packages);
    // Every OpenCode build opencode-ai offers, for every OS and CPU: a
    // lockfile regenerated on one platform must not lose the others'.
    const builds = Object.keys(lock.packages["node_modules/opencode-ai"].optionalDependencies);
    expect(builds.length).toBeGreaterThanOrEqual(6);
    for (const name of builds) {
      expect(lockfile.packages[`node_modules/${name}`]).toMatchObject({
        optional: true,
        os: expect.any(Array),
        cpu: expect.any(Array),
      });
    }
    for (const tool of ["typescript", "vitest", "@biomejs/biome", "@open-cr-agent/eval"]) {
      expect(paths).not.toContain(`node_modules/${tool}`);
    }
    for (const path of paths.filter(Boolean)) {
      expect(lockfile.packages[path]).toMatchObject({
        version: expect.any(String),
        resolved: expect.stringMatching(/^https:\/\//),
        integrity: expect.stringMatching(/^sha512-/),
      });
    }
  });
});
