import type { Sampling } from "@open-cr-agent/core";
import { stableHash } from "@open-cr-agent/core/internal";
import type { CliConfig } from "../../config/cli-config.js";
import type { ReviewArgs } from "./args.js";

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
// URL is dropped. Sampling is recorded on its own. Effort is covered; left
// unset it adds nothing, so configurations that set none keep their hash.
// The ocra Cloud account settings (ADR-0027) add their version and rules
// only when they were layered in, so a signed-out run keeps its hash.
export function configHash(
  config: CliConfig,
  args: ReviewArgs,
  accountSettings?: { version: string | null },
): string {
  const { sampling: _, providers, extends: shared, effort, roles, rules, ...rest } = config;
  const bare = (account: boolean) =>
    rules
      .filter((rule) => (rule.source === "account") === account)
      .map(({ path, rule }) => ({ path, rule }));
  return stableHash({
    ...rest,
    rules: bare(false),
    ...(accountSettings
      ? { account: { version: accountSettings.version, rules: bare(true) } }
      : {}),
    ...(Object.keys(effort).length > 0 ? { effort } : {}),
    ...(Object.keys(roles).length > 0 ? { roles } : {}),
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
