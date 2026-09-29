import type { Instance } from "./dataset.js";

export interface SelectionOptions {
  limit?: number;
  seed: number;
  languages?: readonly string[];
  maxChangeLines?: number;
  ids?: readonly string[];
  // Golden cases only: smoke picks the smoke tier, full every case, and
  // adversarial the attacks with the cases they attack (ADR-0014).
  tier?: "smoke" | "full" | "adversarial";
}

export function selectInstances(all: readonly Instance[], options: SelectionOptions): Instance[] {
  const languages = options.languages?.map((l) => l.toLowerCase());
  const ids = options.ids ? new Set(options.ids) : undefined;
  const eligible = all.filter(
    (i) =>
      (i.references.length > 0 || i.golden !== undefined) &&
      inTier(i, options.tier, ids) &&
      (!ids || ids.has(i.id)) &&
      (!languages || languages.includes(i.language.toLowerCase())) &&
      (options.maxChangeLines === undefined || i.changeLines <= options.maxChangeLines),
  );
  const shuffled = shuffle(eligible, options.seed);
  return withCleanCases(
    options.limit === undefined ? shuffled : shuffled.slice(0, options.limit),
    all,
  );
}

// Attacks cost a review each and answer another question, so they run only
// when asked for, by the adversarial tier or by id.
function inTier(i: Instance, tier: SelectionOptions["tier"], ids?: ReadonlySet<string>): boolean {
  if (i.golden?.attack) return tier === "adversarial" || (ids?.has(i.id) ?? false);
  if (tier === "smoke") return i.golden?.tier === "smoke";
  return tier !== "adversarial";
}

// An attack is measured against its clean case, so the two run together.
function withCleanCases(picked: readonly Instance[], all: readonly Instance[]): Instance[] {
  const have = new Set(picked.map((i) => i.id));
  const clean: Instance[] = [];
  for (const attack of picked) {
    const on = attack.golden?.attack?.on;
    const found = on === undefined || have.has(on) ? undefined : all.find((i) => i.id === on);
    if (!found) continue;
    have.add(found.id);
    clean.push(found);
  }
  return [...clean, ...picked];
}

// Seeded so that a subset baseline can be rerun on exactly the same PRs.
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const result = [...items];
  let state = seed >>> 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}
