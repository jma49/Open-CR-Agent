import { OcraError, type OcraPlugin } from "@open-cr-agent/core";
import { VERSION } from "../../version.js";

// The plugin of each built-in runtime, by the name a configuration gives it,
// imported only when a review uses it: @open-cr-agent/runtime-opencode is an
// optional dependency and may not be installed (ADR-0023). The codex runtime
// is part of the CLI and runs the user's own Codex (ADR-0083).
export type RuntimeLoaders = Readonly<Record<string, () => Promise<OcraPlugin>>>;

export const BUILTIN_RUNTIMES: RuntimeLoaders = {
  opencode: () =>
    loadRuntime(
      "opencode",
      "@open-cr-agent/runtime-opencode",
      async () => (await import("@open-cr-agent/runtime-opencode")).opencodeRuntimePlugin,
    ),
  codex: () => loadCodex(),
  direct: () =>
    loadRuntime(
      "direct",
      "@open-cr-agent/runtime-direct",
      async () => (await import("@open-cr-agent/runtime-direct")).directRuntimePlugin,
    ),
};

export async function loadRuntime(
  runtime: string,
  packageName: string,
  load: () => Promise<OcraPlugin>,
): Promise<OcraPlugin> {
  try {
    return await load();
  } catch (error) {
    if (!isMissingPackage(error, packageName)) throw error;
    const other = runtime === "direct" ? "opencode" : "direct";
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `The ${runtime} runtime needs ${packageName}, which is not installed ` +
        "(an optional dependency of @open-cr-agent/cli, left out by --omit=optional). " +
        `Install it next to ocra with npm install ${packageName}@${VERSION} (-g for a global ocra), ` +
        `or set "runtime": "${other}" in the configuration.`,
      { cause: error },
    );
  }
}

// The codex runtime serves ocra's tools to Codex over MCP, with the SDK that
// comes with ocra's optional dependencies (ADR-0050).
export async function loadCodex(
  load: () => Promise<OcraPlugin> = async () =>
    (await import("../../runtimes/codex/plugin.js")).codexRuntimePlugin,
): Promise<OcraPlugin> {
  try {
    return await load();
  } catch (error) {
    if (!isMissingPackage(error, MCP_SDK)) throw error;
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `The codex runtime needs ${MCP_SDK}, which comes with ocra's optional dependencies ` +
        "(left out by --omit=optional). Reinstall ocra without --omit=optional, " +
        'or set "runtime": "direct" in the configuration.',
      { cause: error },
    );
  }
}

const MCP_SDK = "@modelcontextprotocol/sdk";

// Node reports a bare specifier it cannot resolve as ERR_MODULE_NOT_FOUND,
// naming the package; a module missing inside the package names another.
function isMissingPackage(error: unknown, packageName: string): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ERR_MODULE_NOT_FOUND" && error.message.includes(`'${packageName}'`);
}
