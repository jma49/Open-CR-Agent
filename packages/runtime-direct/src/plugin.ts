import type { OcraPlugin } from "@open-cr-agent/core";
import { DirectRuntime } from "./runtime.js";

export const directRuntimePlugin: OcraPlugin = {
  name: "runtime-direct",
  configure(ctx) {
    ctx.registerRuntime("direct", (options) => new DirectRuntime(options));
  },
};
