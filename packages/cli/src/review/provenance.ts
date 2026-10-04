import { type Sampling, stableHash } from "@open-cr-agent/core";
import type { ReviewArgs } from "./args.js";
import type { CliConfig } from "./config.js";

// The sampling a review asks for: the configuration's, with --temperature
// and --seed on top.
export function requestedSampling(config: CliConfig, args: ReviewArgs): Sampling {
  const temperature = args.temperature ?? config.sampling?.temperature;
  const seed = args.seed ?? config.sampling?.seed;
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(seed === undefined ? {} : { seed }),
  };
}

// The effective configuration and the flags that change what is reviewed
// and how, so two runs can tell they were set up alike. Keys are names of
// environment variables, never their values; a password written into a
// URL is dropped. Sampling is recorded on its own.
export function configHash(config: CliConfig, args: ReviewArgs): string {
  const { sampling: _, providers, extends: shared, ...rest } = config;
  return stableHash({
    ...rest,
    ...(shared === undefined ? {} : { extends: withoutCredentials(shared) }),
    providers: Object.fromEntries(
      Object.entries(providers).map(([id, p]) => [
        id,
        { ...p, baseUrl: withoutCredentials(p.baseUrl) },
      ]),
    ),
    flags: { reviewers: args.reviewers, ultra: args.ultra, maxCostUsd: args.maxCostUsd },
  });
}

function withoutCredentials(value: string): string {
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  if (url.username === "" && url.password === "") return value;
  url.username = "";
  url.password = "";
  return url.toString();
}
