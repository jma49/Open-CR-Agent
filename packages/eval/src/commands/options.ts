import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { proxiedFetch } from "@open-cr-agent/core";
import { loadDataset } from "../dataset.js";
import { loadGolden } from "../golden.js";
import type { Dataset, Instance } from "../instance.js";
import type { SelectionOptions } from "../select.js";

// What a command writes to: stdout or stderr, or a test's buffer.
export interface Output {
  write(chunk: string): unknown;
}

export const CACHE_DIR = join(homedir(), ".cache", "ocra", "aacr-bench");

const OPTIONS = {
  limit: { type: "string" },
  seed: { type: "string" },
  languages: { type: "string" },
  "max-change-lines": { type: "string" },
  ids: { type: "string" },
  dataset: { type: "string" },
  "golden-dir": { type: "string" },
  tier: { type: "string" },
  label: { type: "string" },
  out: { type: "string" },
  "repos-dir": { type: "string" },
  "max-cost-usd": { type: "string" },
  "pr-max-cost-usd": { type: "string" },
  "timeout-minutes": { type: "string" },
  "mock-judge": { type: "boolean" },
  "retry-failed": { type: "boolean" },
  reviewers: { type: "string" },
  ultra: { type: "boolean" },
  config: { type: "string" },
  "spread-of": { type: "string" },
  temperature: { type: "string" },
  "model-seed": { type: "string" },
  repeat: { type: "string" },
} as const;

export function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

export function selection(values: ReturnType<typeof parse>["values"]): SelectionOptions {
  const options: SelectionOptions = { seed: number(values.seed, "--seed") ?? 1 };
  const limit = number(values.limit, "--limit");
  const maxChangeLines = number(values["max-change-lines"], "--max-change-lines");
  if (limit !== undefined) options.limit = limit;
  if (maxChangeLines !== undefined) options.maxChangeLines = maxChangeLines;
  if (values.languages) options.languages = values.languages.split(",").map((l) => l.trim());
  if (values.ids) options.ids = values.ids.split(",").map((i) => i.trim());
  if (values.tier !== undefined) {
    if (values.tier !== "smoke" && values.tier !== "full" && values.tier !== "adversarial") {
      throw new Error("--tier must be smoke, full or adversarial");
    }
    if (dataset(values) !== "golden") throw new Error("--tier needs --dataset golden");
    options.tier = values.tier;
  }
  return options;
}

export function dataset(values: { dataset?: string | undefined }): Dataset {
  const name = values.dataset ?? "aacr";
  if (name !== "aacr" && name !== "golden") throw new Error("--dataset must be aacr or golden");
  return name;
}

export function loadInstances(
  name: Dataset,
  values: { "golden-dir"?: string | undefined },
): Promise<Instance[]> {
  return name === "golden"
    ? loadGolden(resolve(values["golden-dir"] ?? "evals/golden"))
    : loadDataset(join(CACHE_DIR, "dataset.json"), proxiedFetch(process.env));
}

export function number(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error(`${flag} must be a non-negative number`);
  return parsed;
}
