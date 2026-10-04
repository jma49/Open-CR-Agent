import {
  CLOUD_PREFIX,
  EFFORT_STYLES,
  GATEWAY_PATH,
  isCloudModel,
} from "@open-cr-agent/cloud-contract";
import type { CustomProvider } from "@open-cr-agent/core";
import { OcraError } from "@open-cr-agent/core";
import { errorMessage, REVIEW_DEFAULTS } from "@open-cr-agent/core/internal";
import { CloudClient, sessionLostReason } from "./client.js";
import type { CloudDeps } from "./deps.js";
import { GatewayToken } from "./gateway-token.js";

// Models named ocra-<provider>/<model> go through the ocra Cloud gateway with
// the key stored there for <provider> (ADR-0024). Each such provider becomes
// an OpenAI-compatible endpoint declared for this run, authorized by the
// signed-in session's access token. Without such a model nothing here reads
// the session or touches the network.

/** Where the access token travels to the runtime; never a user's variable (OCRA_ is refused in config). */
export const CLOUD_TOKEN_ENV = "OCRA_CLOUD_ACCESS_TOKEN";
// A review runs 25 minutes at most by default; start it with a token that
// outlives that, and ask for one that outlives a longer run.
const MIN_TOKEN_MS = 35 * 60_000;
const TOKEN_MARGIN_MS = 10 * 60_000;

/** The run the models serve: how long it may last, and whether its runtime reads a key at each call. */
export type CloudRun = { timeoutMs: number; keyReadPerCall: boolean };

export type CloudProviders = {
  providers: Record<string, CustomProvider>;
  env: Env;
  // Stops renewing the gateway token; called when the run ends.
  stop(): void;
};

type Env = Readonly<Record<string, string | undefined>>;

// chains: every chain of the run, the tiers' and the agents' own.
export async function withCloudProviders(
  chains: readonly (readonly string[] | undefined)[],
  providers: Readonly<Record<string, CustomProvider>>,
  env: Env,
  deps: CloudDeps | undefined,
  warn: (message: string) => void,
  run: CloudRun = { timeoutMs: REVIEW_DEFAULTS.runTimeoutMs, keyReadPerCall: false },
): Promise<CloudProviders> {
  const wanted = new Map<string, Set<string>>();
  const dropped: string[] = [];
  for (const model of chains.flatMap((chain) => chain ?? [])) {
    const slash = model.indexOf("/");
    const id = model.slice(0, slash);
    if (slash < 0 || !id.startsWith(CLOUD_PREFIX) || providers[id]) continue;
    if (!isCloudModel(model)) {
      dropped.push(JSON.stringify(model));
      continue;
    }
    const set = wanted.get(id) ?? new Set();
    set.add(model.slice(slash + 1));
    wanted.set(id, set);
  }
  if (dropped.length > 0) {
    warn(
      `ignoring ${dropped.join(", ")}: an ocra Cloud model is ${CLOUD_PREFIX}<provider>/<model>, with a provider of lowercase letters, digits and - and a model of letters, digits and ./:@_-`,
    );
  }
  if (wanted.size === 0) return { providers: { ...providers }, env, stop: () => {} };

  const names = [...wanted.keys()].join(", ");
  if (env.OCRA_CLOUD === "off") {
    throw new OcraError("CONFIG_INVALID", `Models name ocra Cloud (${names}) but OCRA_CLOUD=off`);
  }
  const client = deps ? new CloudClient(deps) : undefined;
  // A runtime that reads the key once needs a token that outlives the run;
  // one that reads it at each call gets it renewed during the run.
  const needed = run.timeoutMs + TOKEN_MARGIN_MS;
  const minValidity = run.keyReadPerCall ? MIN_TOKEN_MS : Math.max(MIN_TOKEN_MS, needed);
  const state = client ? await client.session(minValidity) : ({ kind: "signed-out" } as const);
  if (!client || !deps || state.kind === "signed-out") {
    throw new OcraError(
      "CONFIG_CREDENTIALS_MISSING",
      `Models name ocra Cloud (${names}): sign in with ocra login`,
    );
  }
  if (state.kind === "revoked") {
    throw new OcraError(
      "CONFIG_CREDENTIALS_MISSING",
      `Models name ocra Cloud (${names}): ${sessionLostReason(state)}`,
    );
  }
  const unreachable = (reason: string) =>
    new OcraError(
      "RUNTIME_START_FAILED",
      `Models name ocra Cloud (${names}) but ocra Cloud could not be reached (${reason})`,
    );
  if (state.kind === "unreachable") throw unreachable(state.reason);
  const session = state.credentials;
  let answer: Awaited<ReturnType<CloudClient["providers"]>>;
  try {
    answer = await client.providers(session.server);
  } catch (error) {
    throw unreachable(errorMessage(error));
  }
  if (answer.kind === "status" && (answer.status >= 500 || answer.status === 429)) {
    throw unreachable(`HTTP ${answer.status}`);
  }
  if (answer.kind === "malformed") {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      "ocra Cloud's answer for its providers is not a list of providers",
    );
  }
  if (answer.kind !== "ok") {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `ocra Cloud answered ${answer.status} for its providers`,
    );
  }
  const listed = answer.value;

  const declared: Record<string, CustomProvider> = { ...providers };
  for (const [id, modelIds] of wanted) {
    const name = id.slice(CLOUD_PREFIX.length);
    const entry = listed.find((p) => p.name === name);
    const paths = entry?.paths ?? [];
    const valid = paths.filter(
      (path): path is string => typeof path === "string" && GATEWAY_PATH.test(path),
    );
    if (valid.length < paths.length) {
      warn(
        `ignoring ${paths.length - valid.length} gateway path(s) ocra Cloud listed for "${name}" that are not plain paths`,
      );
    }
    const chat = valid.find((path) => path.endsWith("/chat/completions"));
    if (!chat) {
      throw new OcraError(
        "CONFIG_INVALID",
        `ocra Cloud has no OpenAI-compatible chat endpoint for "${name}" (named by ${id})`,
      );
    }
    declared[id] = {
      baseUrl: `${session.server}/api/gateway/${name}${chat.slice(0, -"/chat/completions".length)}`,
      apiKeyEnv: CLOUD_TOKEN_ENV,
      models: Object.fromEntries([...modelIds].map((m) => [m, { input: 0, output: 0 }])),
      ...effortStyleOf(entry?.effort, name, warn),
    };
  }
  warn(
    `${names}: models through ocra Cloud are not priced, so reported cost and --max-cost-usd do not count them`,
  );
  if (!run.keyReadPerCall) {
    const left = session.expires_at - deps.now();
    if (left < needed) {
      warn(
        `this run may last ${minutes(run.timeoutMs)} minutes, but its runtime reads the ocra Cloud token once and the token lasts ${minutes(left)}: model calls through ocra Cloud fail after that (use "runtime": "direct", which renews it, or a shorter runTimeoutMinutes)`,
      );
    }
    return {
      providers: declared,
      env: { ...env, [CLOUD_TOKEN_ENV]: session.access_token },
      stop: () => {},
    };
  }
  const token = new GatewayToken(session, deps, warn);
  token.start();
  // The token is read at each call, so a renewed one is used from then on.
  const live = Object.defineProperty({ ...env }, CLOUD_TOKEN_ENV, {
    get: () => token.value,
    enumerable: true,
  });
  return { providers: declared, env: live, stop: () => token.stop() };
}

function minutes(ms: number): number {
  return Math.floor(ms / 60_000);
}

// How the gateway's provider takes a reasoning effort, as ocra Cloud lists
// it; unlisted, the runtime's default (OpenAI's reasoning_effort). A style
// this version of ocra does not know is refused rather than guessed.
function effortStyleOf(
  style: unknown,
  name: string,
  warn: (message: string) => void,
): Pick<CustomProvider, "effort"> {
  if (style === undefined) return {};
  const known = EFFORT_STYLES.find((s) => s === style);
  if (known) return { effort: known };
  warn(
    `ignoring the effort style ocra Cloud listed for "${name}", which this version of ocra does not know; efforts go as OpenAI's reasoning_effort`,
  );
  return {};
}
