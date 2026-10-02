import {
  LOCAL_KEY,
  LOCAL_KEY_ENV,
  LOCAL_MODELS,
  runtimeConformance,
} from "../../core/src/runtime/conformance.fakes.js";
import { OpenCodeRuntime } from "./runtime.js";

// The real OpenCode binary against the scripted endpoint, as
// custom-provider.test.ts runs it.
runtimeConformance("OpenCodeRuntime", {
  timeoutMs: 120_000,
  runtime: (baseUrl, chain) =>
    new OpenCodeRuntime({
      models: { standard: chain, light: chain },
      tools: [],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        [LOCAL_KEY_ENV]: LOCAL_KEY,
      },
      providers: { local: { baseUrl, apiKeyEnv: LOCAL_KEY_ENV, models: LOCAL_MODELS } },
    }),
});
