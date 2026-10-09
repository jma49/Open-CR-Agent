import { writeFile } from "node:fs/promises";
import { type CustomProvider, errorMessage, withoutSecrets } from "@open-cr-agent/core";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { EffortRoutes } from "./effort.js";

const CATALOG_TIMEOUT_MS = 30_000;

type ConfigApi = Pick<OpencodeClient["config"], "providers">;

interface CatalogModel {
  // 0 when the catalog gives none.
  outputLimit: number;
  variants: ReadonlySet<string>;
}

export interface EffortSetup {
  models: readonly string[];
  custom?: Readonly<Record<string, CustomProvider>>;
  // OpenCode loads its configuration once per directory it serves. The
  // probe's directory is loaded first, to read the catalog; the workspace's
  // after `file` holds the variants (1.18.32 reads `opencode.json` in
  // OPENCODE_CONFIG_DIR for every directory it loads).
  probe: ConfigApi;
  workspace: ConfigApi;
  file: string;
  // Redacted from the reason a failure gives.
  secrets?: readonly string[];
}

// The variants derive thinking budgets from the models' output limits,
// which only OpenCode's catalog knows, and the catalog is loaded only once
// OpenCode runs: the variants are written after it started and before the
// workspace is first used. Any failure leaves effort unsent, with a warning
// per agent that gives the cause, and never fails the review.
export async function setUpEfforts(setup: EffortSetup): Promise<EffortRoutes> {
  const { models, custom = {} } = setup;
  const everyModel = new Map(models.map((m) => [m, 0]));
  if (new EffortRoutes(models, custom, everyModel).empty) return new EffortRoutes([]);
  try {
    const catalog = await catalogModels(setup.probe);
    const routes = new EffortRoutes(
      models,
      custom,
      new Map([...catalog].map(([model, entry]) => [model, entry.outputLimit])),
    );
    if (routes.empty) return routes;
    await writeFile(setup.file, JSON.stringify({ provider: routes.providerConfig() }), {
      mode: 0o600,
    });
    const loaded = await catalogModels(setup.workspace);
    routes.keepLoaded(new Map([...loaded].map(([model, entry]) => [model, entry.variants])));
    return routes;
  } catch (error) {
    return EffortRoutes.unavailable(
      `OpenCode's model catalog could not be read (${withoutSecrets(errorMessage(error), setup.secrets ?? [])})`,
    );
  }
}

async function catalogModels(config: ConfigApi): Promise<Map<string, CatalogModel>> {
  const answer = await config.providers({}, { signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS) });
  const models = new Map<string, CatalogModel>();
  for (const provider of answer.data?.providers ?? []) {
    for (const [id, model] of Object.entries(provider.models)) {
      models.set(`${provider.id}/${id}`, {
        outputLimit: model.limit?.output ?? 0,
        variants: new Set(Object.keys(model.variants ?? {})),
      });
    }
  }
  return models;
}
