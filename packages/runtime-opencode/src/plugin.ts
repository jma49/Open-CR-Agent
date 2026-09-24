import type { OcraPlugin } from "@open-cr-agent/core";
import { OpenCodeRuntime } from "./runtime.js";

export const opencodeRuntimePlugin: OcraPlugin = {
  name: "runtime-opencode",
  configure(ctx) {
    ctx.registerRuntime("opencode", (options) => new OpenCodeRuntime(options));
  },
};
