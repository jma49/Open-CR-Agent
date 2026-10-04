import { spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { type Env, OcraError } from "@open-cr-agent/core";

const PLATFORMS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };

export interface Host {
  platform: string;
  arch: string;
  musl: boolean;
  // x64 without AVX2, which the default build needs.
  baseline: boolean;
}

// Resolved from opencode-ai's platform packages directly, because newer npm
// versions block the postinstall script that would otherwise place it. An
// install without optional dependencies has no platform package, but where
// that script ran, it downloaded the binary into opencode-ai's own bin/.
export function resolveOpencodeBinary(
  env: Env,
  opencodePackage = createRequire(import.meta.url).resolve("opencode-ai/package.json"),
): string {
  const override = env.OCRA_OPENCODE_BIN;
  // OpenCode runs in a directory of its own, where a relative path would
  // not resolve; a bare name is still looked up in PATH.
  if (override) return /[\\/]/.test(override) ? resolve(override) : override;

  const platform = PLATFORMS[process.platform] ?? process.platform;
  const executable = platform === "windows" ? "opencode.exe" : "opencode";
  const fromOpencode = createRequire(opencodePackage);
  for (const variant of binaryVariants(currentHost(platform))) {
    try {
      const pkg = fromOpencode.resolve(
        `opencode-${platform}-${process.arch}${variant}/package.json`,
      );
      const binary = join(dirname(pkg), "bin", executable);
      if (existsSync(binary)) return binary;
    } catch {}
  }
  // The script names the binary opencode.exe on every platform.
  const placed = join(dirname(opencodePackage), "bin", "opencode.exe");
  if (isNativeExecutable(placed)) return placed;
  throw new OcraError(
    "RUNTIME_START_FAILED",
    `No OpenCode binary for ${platform}-${process.arch}: install without --omit=optional, or set OCRA_OPENCODE_BIN`,
  );
}

// Until the install script replaces it, opencode-ai's bin/opencode.exe is a
// shell script that only prints an error, so the file must be a real
// executable: ELF, Mach-O (either byte order, or universal) or Windows PE.
export function isNativeExecutable(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(4);
    if (readSync(fd, head, 0, 4, 0) < 4) return false;
    const magic = head.readUInt32BE(0);
    return (
      magic === 0x7f454c46 ||
      [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic) ||
      head.subarray(0, 2).toString("latin1") === "MZ"
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The builds to try, best first. npm installs every build whose os and cpu
// match, and the glibc builds declare no libc, so musl Linux has both kinds;
// the order follows opencode-ai's own install script.
export function binaryVariants(host: Host): string[] {
  const glibc = host.arch !== "x64" ? [""] : host.baseline ? ["-baseline", ""] : ["", "-baseline"];
  if (host.platform !== "linux") return glibc;
  const musl = glibc.map((variant) => `${variant}-musl`);
  return host.musl ? [...musl, ...glibc] : [...glibc, ...musl];
}

function currentHost(platform: string): Host {
  const x64 = process.arch === "x64";
  return {
    platform,
    arch: process.arch,
    musl: platform === "linux" && isMusl(),
    baseline: x64 && lacksAvx2(platform),
  };
}

// Node's diagnostic report names the glibc it runs on; a musl build has none.
function isMusl(): boolean {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    return !report.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

// Unknown counts as AVX2 present: the default build is tried first, as before.
function lacksAvx2(platform: string): boolean {
  try {
    if (platform === "linux") return !/\bavx2\b/.test(readFileSync("/proc/cpuinfo", "utf8"));
    if (platform === "darwin") {
      const sysctl = spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      });
      return sysctl.status === 0 && sysctl.stdout.trim() === "0";
    }
  } catch {}
  return false;
}
