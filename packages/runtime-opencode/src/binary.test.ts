import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { binaryVariants, isNativeExecutable, resolveOpencodeBinary } from "./binary.js";

describe("resolveOpencodeBinary", () => {
  it("resolves a relative override here, since OpenCode runs in a directory of its own", () => {
    expect(resolveOpencodeBinary({ OCRA_OPENCODE_BIN: "bin/opencode" })).toBe(
      resolve("bin/opencode"),
    );
    expect(resolveOpencodeBinary({ OCRA_OPENCODE_BIN: "/opt/opencode" })).toBe(
      resolve("/opt/opencode"),
    );
    // A bare name is looked up in PATH, wherever OpenCode runs.
    expect(resolveOpencodeBinary({ OCRA_OPENCODE_BIN: "opencode" })).toBe("opencode");
  });
});

// What opencode-ai ships as bin/opencode.exe until its install script runs.
const PLACEHOLDER = 'echo "Error: opencode-ai\'s postinstall script was not run." >&2\nexit 1\n';
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

describe("resolveOpencodeBinary in an installed layout", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // node_modules with opencode-ai, its bin/opencode.exe, and optionally the
  // platform package npm installs as an optional dependency.
  function install(placed: Buffer | string, platformPackage = false): string {
    const root = mkdtempSync(join(tmpdir(), "ocra-binary-"));
    dirs.push(root);
    const opencode = join(root, "node_modules", "opencode-ai");
    mkdirSync(join(opencode, "bin"), { recursive: true });
    writeFileSync(join(opencode, "package.json"), '{ "name": "opencode-ai" }');
    writeFileSync(join(opencode, "bin", "opencode.exe"), placed);
    if (platformPackage) {
      const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[
        process.platform as "darwin" | "linux" | "win32"
      ];
      const pkg = join(root, "node_modules", `opencode-${platform}-${process.arch}`);
      mkdirSync(join(pkg, "bin"), { recursive: true });
      writeFileSync(join(pkg, "package.json"), "{}");
      writeFileSync(join(pkg, "bin", platform === "windows" ? "opencode.exe" : "opencode"), ELF);
    }
    return join(opencode, "package.json");
  }

  it("uses the binary opencode-ai's install script placed in its bin/ without optional dependencies", () => {
    const pkg = install(ELF);
    expect(resolveOpencodeBinary({}, pkg)).toBe(join(pkg, "..", "bin", "opencode.exe"));
  });

  it("never takes the placeholder script opencode-ai ships there", () => {
    expect(() => resolveOpencodeBinary({}, install(PLACEHOLDER))).toThrow(
      /No OpenCode binary .*--omit=optional.*OCRA_OPENCODE_BIN/,
    );
  });

  it("prefers the platform package", () => {
    const pkg = install(ELF, true);
    expect(resolveOpencodeBinary({}, pkg)).toMatch(
      /node_modules[\\/]opencode-(darwin|linux|windows)-[a-z0-9]+[\\/]bin[\\/]opencode(\.exe)?$/,
    );
  });
});

describe("isNativeExecutable", () => {
  const dir = mkdtempSync(join(tmpdir(), "ocra-magic-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name: string, content: Buffer | string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it("recognizes ELF, Mach-O and PE executables", () => {
    expect(isNativeExecutable(file("elf", ELF))).toBe(true);
    expect(isNativeExecutable(file("macho", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0])))).toBe(
      true,
    );
    expect(isNativeExecutable(file("fat", Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 2])))).toBe(true);
    expect(isNativeExecutable(file("pe", Buffer.from("MZ\x90\x00", "latin1")))).toBe(true);
  });

  it("rejects scripts, short files and missing files", () => {
    expect(isNativeExecutable(file("stub", PLACEHOLDER))).toBe(false);
    expect(isNativeExecutable(file("shebang", "#!/bin/sh\nexit 1\n"))).toBe(false);
    expect(isNativeExecutable(file("short", "MZ"))).toBe(false);
    expect(isNativeExecutable(join(dir, "missing"))).toBe(false);
  });
});

const host = { platform: "linux", arch: "x64", musl: false, baseline: false };

describe("binaryVariants", () => {
  it("tries the default build first on glibc x64 with AVX2", () => {
    expect(binaryVariants(host)).toEqual(["", "-baseline", "-musl", "-baseline-musl"]);
  });

  it("tries the musl builds first on musl Linux, where npm installs the glibc builds too", () => {
    expect(binaryVariants({ ...host, musl: true })).toEqual([
      "-musl",
      "-baseline-musl",
      "",
      "-baseline",
    ]);
    expect(binaryVariants({ ...host, arch: "arm64", musl: true })).toEqual(["-musl", ""]);
  });

  it("tries the baseline build first on x64 without AVX2", () => {
    expect(binaryVariants({ ...host, baseline: true })).toEqual([
      "-baseline",
      "",
      "-baseline-musl",
      "-musl",
    ]);
    expect(binaryVariants({ ...host, platform: "darwin", baseline: true })).toEqual([
      "-baseline",
      "",
    ]);
  });

  it("has one build on arm64 outside Linux", () => {
    expect(binaryVariants({ ...host, platform: "darwin", arch: "arm64" })).toEqual([""]);
    expect(binaryVariants({ ...host, platform: "windows", arch: "arm64" })).toEqual([""]);
  });
});
