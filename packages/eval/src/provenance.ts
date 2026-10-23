import { createHash } from "node:crypto";
import type { AppliedSampling } from "@open-cr-agent/core";
import { z } from "zod";
import { ocraBuildSchema, renderBuild } from "./ocra-build.js";
import { catalogSchema, opencodeSchema } from "./ran-on.js";
import type { InstanceResult } from "./results.js";

const agentSetupSchema = z.strictObject({
  tier: z.string(),
  models: z.array(z.string()).exactOptional(),
  effort: z.string().exactOptional(),
});
type AgentSetups = Record<string, z.output<typeof agentSetupSchema>>;

// The distinct values the reviews of a run recorded. One each is the normal
// case; more mean the run was resumed after a rebuild or a change of setup.
// The fields after sampling are absent from runs made before ocra-eval
// recorded them, and null for a review of the run that recorded none.
export const provenanceSummarySchema = z.object({
  ocraVersion: z.array(z.string()),
  promptHash: z.array(z.string()),
  configHash: z.array(z.string()),
  sampling: z.array(z.custom<AppliedSampling>((v) => typeof v === "object" && v !== null)),
  // Each agent's tier, model chain and effort, from the reviews' reports.
  agents: z.array(z.record(z.string(), agentSetupSchema).nullable()).exactOptional(),
  // The rest from the PRs' results (ran-on.ts).
  ocra: z.array(ocraBuildSchema.nullable()).exactOptional(),
  runtime: z.array(z.string().nullable()).exactOptional(),
  opencode: z.array(opencodeSchema.nullable()).exactOptional(),
  catalog: z.array(catalogSchema.nullable()).exactOptional(),
});
export type ProvenanceSummary = z.output<typeof provenanceSummarySchema>;
type Key = keyof ProvenanceSummary;

export function summarizeProvenance(
  results: readonly InstanceResult[],
): ProvenanceSummary | undefined {
  const reviewed = results.filter((r) => r.status === "reviewed" && r.provenance);
  const recorded = reviewed.flatMap((r) => (r.provenance ? [r.provenance] : []));
  if (recorded.length === 0) return undefined;
  const summary: ProvenanceSummary = {
    ocraVersion: distinct(recorded.map((p) => p.ocraVersion)),
    promptHash: distinct(recorded.map((p) => p.promptHash)),
    configHash: distinct(recorded.map((p) => p.configHash)),
    sampling: distinct(recorded.map((p) => p.sampling)),
  };
  const optional = <T>(pick: (r: InstanceResult) => T | undefined): (T | null)[] | undefined =>
    reviewed.some((r) => pick(r) !== undefined)
      ? distinct(reviewed.map((r) => pick(r) ?? null))
      : undefined;
  const agents = optional((r) => agentSetups(r.provenance?.agents));
  const ocra = optional((r) => r.ranOn?.ocra);
  const runtime = optional((r) => r.ranOn?.runtime);
  const opencode = optional((r) => r.ranOn?.opencode);
  const catalog = optional((r) => r.ranOn?.catalog);
  if (agents) summary.agents = agents;
  if (ocra) summary.ocra = ocra;
  if (runtime) summary.runtime = runtime;
  if (opencode) summary.opencode = opencode;
  if (catalog) summary.catalog = catalog;
  return summary;
}

function agentSetups(
  agents: NonNullable<InstanceResult["provenance"]>["agents"],
): AgentSetups | undefined {
  if (!agents) return undefined;
  const ids = Object.keys(agents).sort();
  return Object.fromEntries(
    ids.flatMap((id) => {
      const agent = agents[id];
      if (!agent) return [];
      const { tier, models, effort } = agent;
      return [[id, { tier, ...(models ? { models } : {}), ...(effort ? { effort } : {}) }]];
    }),
  );
}

function distinct<T>(values: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const v of values) seen.set(JSON.stringify(v), v);
  return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
}

interface Field {
  key: Key;
  what: string;
  // How one value reads in a warning; JSON when absent.
  show?: (value: never) => string;
}

const notRecorded =
  <T>(show: (value: T) => string) =>
  (value: T | null) =>
    value === null ? "not recorded" : show(value);

const FIELDS: Field[] = [
  { key: "ocraVersion", what: "ocra versions" },
  { key: "promptHash", what: "prompts (promptHash)" },
  { key: "configHash", what: "configurations (configHash)" },
  { key: "sampling", what: "sampling settings" },
  { key: "ocra", what: "ocra builds", show: notRecorded(renderBuild) },
  { key: "runtime", what: "runtimes", show: notRecorded((r: string) => r) },
  { key: "opencode", what: "OpenCode installs", show: notRecorded(showOpencode) },
  { key: "agents", what: "model chains per agent", show: notRecorded(showAgents) },
  { key: "catalog", what: "OpenCode catalog entries", show: notRecorded(showCatalog) },
];

// What ocra-eval records beside ocra's own provenance: a run made before
// it lacks every one.
const LATER = new Set<Key>(["agents", "ocra", "runtime", "opencode", "catalog"]);

function showOpencode(o: z.output<typeof opencodeSchema>): string {
  return [o.version ?? "unknown version", ...(o.bin ? [`OCRA_OPENCODE_BIN ${o.bin}`] : [])].join(
    ", ",
  );
}

function showAgents(agents: AgentSetups): string {
  return Object.entries(agents)
    .map(([id, a]) => `${id} ${a.models?.join(" > ") ?? a.tier}${a.effort ? ` (${a.effort})` : ""}`)
    .join(", ");
}

// Input and output prices per million tokens, and a digest of the whole
// entries, which tiers and limits change too.
function showCatalog(catalog: z.output<typeof catalogSchema>): string {
  const prices = Object.entries(catalog).map(([model, entry]) => {
    const cost = entry.cost as { input?: unknown; output?: unknown } | undefined;
    return `${model} $${String(cost?.input ?? "?")}/$${String(cost?.output ?? "?")}`;
  });
  const digest = createHash("sha256").update(JSON.stringify(catalog)).digest("hex").slice(0, 8);
  return `${prices.join(", ") || "no entries"} [${digest}]`;
}

function render(field: Field, value: unknown): string {
  return field.show ? (field.show as (v: unknown) => string)(value) : JSON.stringify(value);
}

/**
 * What differs among the reviews of runs that should be one setup: one
 * run, or the repetitions of one. A run resumed after a rebuild, a change
 * of setup or a catalog refresh mixes them, and its numbers measure no one
 * setup.
 */
export function mixedSetups(runs: readonly (ProvenanceSummary | undefined)[]): string[] {
  const known = runs.filter((p): p is ProvenanceSummary => p !== undefined);
  const mixed: string[] = [];
  for (const field of FIELDS) {
    if (!known.some((p) => p[field.key] !== undefined)) continue;
    const values = distinct(known.flatMap((p): unknown[] => p[field.key] ?? [null]));
    if (values.length > 1) {
      mixed.push(
        `its reviews were made with different ${field.what}: ${values.map((v) => render(field, v)).join(" vs ")}`,
      );
    }
  }
  return mixed;
}

// What else differs between runs besides the change under test. Runs from
// before provenance was recorded cannot be checked, and say so. Two runs
// compared are usually two commits, so their builds are compared only when
// asked (trend, within a series); a checkout with uncommitted changes, which
// its commit does not identify, is always named.
export function provenanceWarnings(
  runs: readonly (ProvenanceSummary | undefined)[],
  { builds = false }: { builds?: boolean } = {},
): string[] {
  const known = runs.filter((p): p is ProvenanceSummary => p !== undefined);
  const warnings: string[] = [];
  if (known.length > 0 && known.length < runs.length) {
    warnings.push(
      "some runs record no provenance (ocra version, prompts, configuration, sampling), so those cannot be compared",
    );
  }
  const unrecorded = FIELDS.filter(
    (f) =>
      LATER.has(f.key) &&
      known.some((p) => p[f.key] !== undefined) &&
      known.some((p) => p[f.key] === undefined),
  );
  if (unrecorded.length > 0) {
    warnings.push(
      `some runs record no ${unrecorded.map((f) => f.what).join(", ")}: an older ocra-eval made them, so those cannot be compared`,
    );
  }
  for (const field of FIELDS) {
    if (field.key === "ocra" && !builds) continue;
    const values = new Map<string, unknown[]>();
    for (const p of known) {
      const value = p[field.key];
      if (value !== undefined) values.set(JSON.stringify(value), value);
    }
    if (values.size > 1) {
      const shown = [...values.values()].map((v) =>
        field.show ? v.map((x) => render(field, x)).join(" + ") : JSON.stringify(v),
      );
      warnings.push(`the runs were made with different ${field.what}: ${shown.join(" vs ")}`);
    }
  }
  if (known.some((p) => p.ocra?.some((b) => b?.dirty === true))) {
    warnings.push(
      "a run was made by an ocra checkout with uncommitted changes, which its commit does not identify",
    );
  }
  return warnings;
}

export function renderProvenance(p: ProvenanceSummary | undefined): string {
  if (!p) return "not recorded";
  const sampling = p.sampling.map((s) => {
    const parts = [
      ...(s.temperature === undefined ? [] : [`temperature ${s.temperature}`]),
      ...(s.seed === undefined ? [] : [`seed ${s.seed}`]),
      ...(s.notApplied?.length ? [`not applied: ${s.notApplied.join(", ")}`] : []),
    ];
    return parts.length > 0 ? parts.join(", ") : "provider defaults";
  });
  const list = <T>(values: readonly (T | null)[], show: (value: T) => string) =>
    values.map(notRecorded(show)).join("; ");
  const chains = (agents: AgentSetups) =>
    distinct(Object.values(agents).map((a) => a.models?.join(" > ") ?? a.tier)).join(", ");
  return [
    `ocra ${p.ocraVersion.join(", ")}`,
    `prompts ${p.promptHash.join(", ")}`,
    `config ${p.configHash.join(", ")}`,
    `sampling ${sampling.join("; ")}`,
    ...(p.ocra ? [`build ${list(p.ocra, (b) => b.commit?.slice(0, 12) ?? b.version)}`] : []),
    ...(p.runtime ? [`runtime ${list(p.runtime, (r) => r)}`] : []),
    ...(p.opencode ? [`OpenCode ${list(p.opencode, showOpencode)}`] : []),
    ...(p.agents ? [`models ${list(p.agents, chains)}`] : []),
    ...(p.catalog ? [`catalog ${list(p.catalog, showCatalog)}`] : []),
  ].join(" · ");
}
