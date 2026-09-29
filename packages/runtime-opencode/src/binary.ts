import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Env } from "@open-cr-agent/core";

const PLATFORMS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };

export interface Host {
  platform: string;
  arch: string;
  musl: boolean;
  // x64 without AVX2, which the default build needs.
  baseline: boolean;
}

// Resolved from opencode-ai's platform packages directly, because newer npm
// versions block the postinstall script that would otherwise place it.
export function resolveOpencodeBinary(env: Env): string {
  const override = env.OCRA_OPENCODE_BIN;
  if (override) return override;

  const platform = PLATFORMS[process.platform] ?? process.platform;
  const executable = platform === "windows" ? "opencode.exe" : "opencode";
  const fromOpencode = createRequire(
    createRequire(import.meta.url).resolve("opencode-ai/package.json"),
  );
  for (const variant of binaryVariants(currentHost(platform))) {
    try {
      const pkg = fromOpencode.resolve(
        `opencode-${platform}-${process.arch}${variant}/package.json`,
      );
      const binary = join(dirname(pkg), "bin", executable);
      if (existsSync(binary)) return binary;
    } catch {}
  }
  throw new Error(`No OpenCode binary for ${platform}-${process.arch}; set OCRA_OPENCODE_BIN`);
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
