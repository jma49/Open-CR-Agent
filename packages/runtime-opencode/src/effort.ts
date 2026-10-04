import {
  type AppliedSettings,
  type CustomProvider,
  EFFORT_LEVELS,
  type Effort,
  effortCapability,
  parseModel,
  type Sampling,
  thinkingBudget,
} from "@open-cr-agent/core";

type Options = Record<string, unknown>;
const GOOGLE_PROVIDERS = new Set(["google", "google-vertex"]);

// OpenCode merges a configured variant over a built-in one of the same name
// (1.18.32 has "high" and "max" for most models), so ocra's carry a prefix.
function effortVariant(level: Effort): string {
  return `ocra-${level}`;
}

// The provider options that carry a level to one model through OpenCode, in
// the option names of the provider's AI SDK package; {} when the level means
// sending nothing (no thinking for Anthropic), undefined when ocra knows no
// way to send it. A provider declared in configuration takes a level the
// way it says (`effort`), for any model the table does not rule out, as on
// the direct runtime.
export function effortOptions(
  model: string,
  level: Effort,
  custom: Readonly<Record<string, CustomProvider>> = {},
  outputLimit?: number,
): Options | undefined {
  const { providerID } = parseModel(model);
  const capability = effortCapability(model);
  if (capability && !capability.levels.includes(level)) return undefined;
  const declared = custom[providerID];
  if (declared) {
    return declared.effort === "openrouter"
      ? { reasoning: { effort: level } }
      : { reasoningEffort: level };
  }
  if (!capability) return undefined;
  if (providerID === "openrouter") return { reasoning: { effort: level } };
  const google = GOOGLE_PROVIDERS.has(providerID);
  switch (capability.parameter) {
    case "reasoningEffort":
      return providerID === "openai" ? { reasoningEffort: level } : undefined;
    case "thinkingLevel":
      return google ? { thinkingConfig: { thinkingLevel: level } } : undefined;
    case "thinkingBudget": {
      const budget = thinkingBudget(capability, level, outputLimit);
      if (budget === undefined) return undefined;
      if (providerID === "anthropic") {
        return budget === 0 ? {} : { thinking: { type: "enabled", budgetTokens: budget } };
      }
      // OpenCode asks Gemini for thoughts, which Gemini refuses with
      // thinking off.
      if (google) {
        return {
          thinkingConfig:
            budget === 0
              ? { thinkingBudget: 0, includeThoughts: false }
              : { thinkingBudget: budget },
        };
      }
      return undefined;
    }
  }
}

// What each model can take, as OpenCode variants: one per (model, level)
// that sends something, so two agents on one model at different levels get
// different options. Only models OpenCode's catalog (or the configuration)
// knows get any, since declaring an unknown model would make OpenCode
// accept it at a price of 0.
export class EffortRoutes {
  private readonly routes = new Map<string, Map<Effort, Options>>();

  constructor(
    models: readonly string[],
    custom: Readonly<Record<string, CustomProvider>> = {},
    // Output limits by model, from OpenCode's catalog; 0 when it has none.
    known: ReadonlyMap<string, number> = new Map(),
  ) {
    for (const model of new Set(models)) {
      if (!known.has(model)) continue;
      const levels = new Map<Effort, Options>();
      for (const level of EFFORT_LEVELS) {
        const options = effortOptions(model, level, custom, known.get(model));
        if (options) levels.set(level, options);
      }
      if (levels.size > 0) this.routes.set(model, levels);
    }
  }

  get empty(): boolean {
    return this.routes.size === 0;
  }

  // The `provider` section that declares the variants.
  providerConfig(): Record<string, { models: Record<string, { variants: Options }> }> {
    const config: Record<string, { models: Record<string, { variants: Options }> }> = {};
    for (const [model, levels] of this.routes) {
      const { providerID, modelID } = parseModel(model);
      const variants = Object.fromEntries(
        [...levels]
          .filter(([, options]) => Object.keys(options).length > 0)
          .map(([level, options]) => [effortVariant(level), options]),
      );
      if (Object.keys(variants).length === 0) continue;
      config[providerID] ??= { models: {} };
      config[providerID].models[modelID] = { variants };
    }
    return config;
  }

  // Keeps the levels whose variant OpenCode loaded, so a level is never
  // recorded as sent when OpenCode would have ignored its variant.
  keepLoaded(loaded: ReadonlyMap<string, ReadonlySet<string>>): void {
    for (const [model, levels] of this.routes) {
      for (const [level, options] of levels) {
        const needsVariant = Object.keys(options).length > 0;
        if (needsVariant && !loaded.get(model)?.has(effortVariant(level))) levels.delete(level);
      }
    }
  }

  // Undefined: the level cannot be sent to the model. No variant: the level
  // is sent by sending nothing.
  route(model: string, level: Effort): { variant?: string } | undefined {
    const options = this.routes.get(model)?.get(level);
    if (!options) return undefined;
    return Object.keys(options).length > 0 ? { variant: effortVariant(level) } : {};
  }
}

// What the run applied per agent (ADR-0025), as the direct runtime records
// it: a call that asks for an effort other than "none" goes without the
// configured sampling, even when its level could not be sent, so an
// agent's calls stay alike within a run.
export class AppliedEfforts {
  private readonly applied = new Map<string, AppliedSettings>();

  constructor(private readonly sampling: Sampling = {}) {}

  // Whether the call keeps the configured sampling.
  record(agent: string, effort: Effort, model: string, sent: boolean): boolean {
    const keepsSampling = effort === "none";
    const before = this.applied.get(agent);
    const notApplied = [
      ...new Set([...(before?.notApplied ?? []), ...(keepsSampling ? [] : this.requested())]),
    ];
    const unsupported = [...new Set([...(before?.unsupported ?? []), ...(sent ? [] : [model])])];
    this.applied.set(agent, {
      effort: (before?.effort ?? true) && sent,
      ...(unsupported.length > 0 ? { unsupported } : {}),
      ...(notApplied.length > 0 ? { notApplied } : {}),
    });
    return keepsSampling;
  }

  appliedTo(agent: string): AppliedSettings | undefined {
    const applied = this.applied.get(agent);
    return applied && structuredClone(applied);
  }

  private requested(): (keyof Sampling)[] {
    return (["temperature", "seed"] as const).filter((key) => this.sampling[key] !== undefined);
  }
}
