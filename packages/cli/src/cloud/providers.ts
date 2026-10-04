import type { CustomProvider } from "@open-cr-agent/core";
import { OcraError } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core/internal";
import { CloudClient, sessionLostReason } from "./client.js";
import type { CloudDeps } from "./deps.js";

// Models named ocra-<provider>/<model> go through the ocra Cloud gateway with
// the key stored there for <provider> (ADR-0024). Each such provider becomes
// an OpenAI-compatible endpoint declared for this run, authorized by the
// signed-in session's access token. Without such a model nothing here reads
// the session or touches the network.

export const CLOUD_PREFIX = "ocra-";
/** Where the access token travels to the runtime; never a user's variable (OCRA_ is refused in config). */
export const CLOUD_TOKEN_ENV = "OCRA_CLOUD_ACCESS_TOKEN";
// What ocra Cloud may name. Anything else is dropped before it reaches the
// runtime's configuration.
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_ID = /^[\w./:@-]{1,200}$/;
const GATEWAY_PATH = /^\/[\w./-]+$/;

/** Whether `model` is ocra-<provider>/<model> with a provider name and model id ocra Cloud may use. */
export function isCloudModel(model: string): boolean {
  const slash = model.indexOf("/");
  return (
    slash > 0 &&
    model.startsWith(CLOUD_PREFIX) &&
    PROVIDER_NAME.test(model.slice(CLOUD_PREFIX.length, slash)) &&
    MODEL_ID.test(model.slice(slash + 1))
  );
}

// A review may run for half an hour; start it with a token that outlives it.
const MIN_TOKEN_MS = 35 * 60_000;

type Env = Readonly<Record<string, string | undefined>>;

// chains: every chain of the run, the tiers' and the agents' own.
export async function withCloudProviders(
  chains: readonly (readonly string[] | undefined)[],
  providers: Readonly<Record<string, CustomProvider>>,
  env: Env,
  deps: CloudDeps | undefined,
  warn: (message: string) => void,
): Promise<{ providers: Record<string, CustomProvider>; env: Env }> {
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
  if (wanted.size === 0) return { providers: { ...providers }, env };

  const names = [...wanted.keys()].join(", ");
  if (env.OCRA_CLOUD === "off") {
    throw new OcraError("CONFIG_INVALID", `Models name ocra Cloud (${names}) but OCRA_CLOUD=off`);
  }
  const client = deps ? new CloudClient(deps) : undefined;
  const state = client ? await client.session(MIN_TOKEN_MS) : ({ kind: "signed-out" } as const);
  if (!client || state.kind === "signed-out") {
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
    const paths = listed.find((p) => p.name === name)?.paths ?? [];
    const valid = paths.filter((path) => typeof path === "string" && GATEWAY_PATH.test(path));
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
    };
  }
  warn(
    `${names}: models through ocra Cloud are not priced, so reported cost and --max-cost-usd do not count them`,
  );
  return { providers: declared, env: { ...env, [CLOUD_TOKEN_ENV]: session.access_token } };
}
