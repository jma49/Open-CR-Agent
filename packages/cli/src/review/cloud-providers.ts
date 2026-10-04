import type { CustomProvider } from "@open-cr-agent/core";
import { OcraError } from "@open-cr-agent/core";
import { errorMessage } from "@open-cr-agent/core/internal";
import { type CloudDeps, cloudSession, sessionLostReason } from "../cloud.js";

// Models named ocra-<provider>/<model> go through the ocra Cloud gateway with
// the key stored there for <provider> (ADR-0024). Each such provider becomes
// an OpenAI-compatible endpoint declared for this run, authorized by the
// signed-in session's access token. Without such a model nothing here reads
// the session or touches the network.

export const CLOUD_PREFIX = "ocra-";
/** Where the access token travels to the runtime; never a user's variable (OCRA_ is refused in config). */
export const CLOUD_TOKEN_ENV = "OCRA_CLOUD_ACCESS_TOKEN";
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
  for (const model of chains.flatMap((chain) => chain ?? [])) {
    const slash = model.indexOf("/");
    const id = model.slice(0, slash);
    if (slash < 0 || !id.startsWith(CLOUD_PREFIX) || providers[id]) continue;
    const set = wanted.get(id) ?? new Set();
    set.add(model.slice(slash + 1));
    wanted.set(id, set);
  }
  if (wanted.size === 0) return { providers: { ...providers }, env };

  const names = [...wanted.keys()].join(", ");
  if (env.OCRA_CLOUD === "off") {
    throw new OcraError("CONFIG_INVALID", `Models name ocra Cloud (${names}) but OCRA_CLOUD=off`);
  }
  const state = deps ? await cloudSession(deps, MIN_TOKEN_MS) : ({ kind: "signed-out" } as const);
  if (state.kind === "signed-out") {
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
  let res: Response;
  try {
    res = await (deps as CloudDeps).fetch(`${session.server}/api/providers`, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw unreachable(errorMessage(error));
  }
  if (res.status >= 500 || res.status === 429) throw unreachable(`HTTP ${res.status}`);
  if (!res.ok) {
    throw new OcraError(
      "RUNTIME_START_FAILED",
      `ocra Cloud answered ${res.status} for its providers`,
    );
  }
  const listed =
    ((await res.json()) as { providers?: { name: string; paths: string[] }[] }).providers ?? [];

  const declared: Record<string, CustomProvider> = { ...providers };
  for (const [id, modelIds] of wanted) {
    const name = id.slice(CLOUD_PREFIX.length);
    const chat = listed
      .find((p) => p.name === name)
      ?.paths.find((path) => path.endsWith("/chat/completions"));
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
