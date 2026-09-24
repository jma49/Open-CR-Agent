import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Env } from "@open-cr-agent/core";

const PLATFORMS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };

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
  for (const variant of ["", "-baseline", "-musl", "-baseline-musl"]) {
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
