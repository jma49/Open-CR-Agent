import type { Instance } from "./dataset.js";

export interface SelectionOptions {
  limit?: number;
  seed: number;
  languages?: readonly string[];
  maxChangeLines?: number;
  ids?: readonly string[];
}

export function selectInstances(all: readonly Instance[], options: SelectionOptions): Instance[] {
  const languages = options.languages?.map((l) => l.toLowerCase());
  const ids = options.ids ? new Set(options.ids) : undefined;
  const eligible = all.filter(
    (i) =>
      i.references.length > 0 &&
      (!ids || ids.has(i.id)) &&
      (!languages || languages.includes(i.language.toLowerCase())) &&
      (options.maxChangeLines === undefined || i.changeLines <= options.maxChangeLines),
  );
  const shuffled = shuffle(eligible, options.seed);
  return options.limit === undefined ? shuffled : shuffled.slice(0, options.limit);
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
