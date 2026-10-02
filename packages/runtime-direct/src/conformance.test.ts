import {
  LOCAL_KEY,
  LOCAL_KEY_ENV,
  LOCAL_MODELS,
  runtimeConformance,
} from "../../core/src/runtime/conformance.fakes.js";
import { DirectRuntime } from "./runtime.js";

runtimeConformance("DirectRuntime", {
  runtime: (baseUrl, chain) =>
    new DirectRuntime({
      models: { standard: chain, light: chain },
      tools: [],
      env: { [LOCAL_KEY_ENV]: LOCAL_KEY },
      providers: { local: { baseUrl, apiKeyEnv: LOCAL_KEY_ENV, models: LOCAL_MODELS } },
    }),
});
