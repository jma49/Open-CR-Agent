import type { AppliedSampling, RunProvenance } from "@open-cr-agent/core";
import type { InstanceResult } from "./results.js";

// The distinct values the reviews of a run recorded. One each is the normal
// case; more mean the run was resumed after a rebuild or a change of setup.
export interface ProvenanceSummary {
  ocraVersion: string[];
  promptHash: string[];
  configHash: string[];
  sampling: AppliedSampling[];
}

export function summarizeProvenance(
  results: readonly InstanceResult[],
): ProvenanceSummary | undefined {
  const recorded = results.flatMap((r) =>
    r.status === "reviewed" && r.provenance ? [r.provenance] : [],
  );
  if (recorded.length === 0) return undefined;
  const distinct = <T>(pick: (p: RunProvenance) => T): T[] => {
    const seen = new Map<string, T>();
    for (const p of recorded) seen.set(JSON.stringify(pick(p)), pick(p));
    return [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, v]) => v);
  };
  return {
    ocraVersion: distinct((p) => p.ocraVersion),
    promptHash: distinct((p) => p.promptHash),
    configHash: distinct((p) => p.configHash),
    sampling: distinct((p) => p.sampling),
  };
}

const FIELDS: { key: keyof ProvenanceSummary; what: string }[] = [
  { key: "ocraVersion", what: "ocra versions" },
  { key: "promptHash", what: "prompts (promptHash)" },
  { key: "configHash", what: "configurations (configHash)" },
  { key: "sampling", what: "sampling settings" },
];

// What else differs between runs besides the change under test. Runs from
// before provenance was recorded cannot be checked, and say so.
export function provenanceWarnings(runs: readonly (ProvenanceSummary | undefined)[]): string[] {
  const known = runs.filter((p): p is ProvenanceSummary => p !== undefined);
  const warnings: string[] = [];
  if (known.length > 0 && known.length < runs.length) {
    warnings.push(
      "some runs record no provenance (ocra version, prompts, configuration, sampling), so those cannot be compared",
    );
  }
  for (const { key, what } of FIELDS) {
    const values = known.map((p) => JSON.stringify(p[key]));
    if (new Set(values).size > 1) {
      warnings.push(
        `the runs were made with different ${what}: ${[...new Set(values)].join(" vs ")}`,
      );
    } else if (known.some((p) => p[key].length > 1)) {
      warnings.push(
        `a run mixes reviews made with different ${what}; it was resumed after a change`,
      );
    }
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
  return [
    `ocra ${p.ocraVersion.join(", ")}`,
    `prompts ${p.promptHash.join(", ")}`,
    `config ${p.configHash.join(", ")}`,
    `sampling ${sampling.join("; ")}`,
  ].join(" · ");
}
