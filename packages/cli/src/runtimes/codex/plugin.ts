import type { OcraPlugin } from "@open-cr-agent/core";
import { CodexRuntime } from "./runtime.js";

export const codexRuntimePlugin: OcraPlugin = {
  name: "runtime-codex",
  configure(ctx) {
    ctx.registerRuntime("codex", (options) => new CodexRuntime(options));
  },
};
