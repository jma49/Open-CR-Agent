import type { CustomProvider } from "@open-cr-agent/core";
import { CLOUD_PREFIX } from "../../cloud/providers.js";

// The input prices --plan estimates with, in US dollars per million tokens:
// a declared provider's; 0 for a model through ocra Cloud, which is not
// priced; undefined for any other, which only the runtime's catalog prices
// and a plan, calling nothing, does not read.
export function inputPriceOf(
  providers: Readonly<Record<string, CustomProvider>>,
): (model: string) => number | undefined {
  return (model) => {
    const slash = model.indexOf("/");
    if (slash < 0) return undefined;
    const provider = model.slice(0, slash);
    const declared = providers[provider]?.models[model.slice(slash + 1)];
    if (declared) return declared.input;
    return provider.startsWith(CLOUD_PREFIX) && !providers[provider] ? 0 : undefined;
  };
}
