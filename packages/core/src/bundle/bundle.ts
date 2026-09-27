import type { FileDiff } from "../domain.js";
import { errorMessage } from "../errors.js";
import { buildGroupingPrompt, type FileGrouper, groupingResponseSchema } from "./grouping.js";

export interface Bundle {
  label: string;
  files: FileDiff[];
}

export type BundleStrategy = "single" | "small_set" | "grouped" | "per_file" | "per_directory";

export interface BundleResult {
  bundles: Bundle[];
  strategy: BundleStrategy;
  warnings: string[];
}

export interface BundlePolicy {
  groupingMinFiles: number;
  maxFilesPerBundle: number;
  maxBundleChars: number;
  // Without a model's grouping, up to this many files are reviewed one per
  // task; more are grouped by directory so tasks do not grow with every file.
  perFileMaxFiles?: number;
}

export const defaultBundlePolicy: BundlePolicy = {
  groupingMinFiles: 4,
  maxFilesPerBundle: 10,
  maxBundleChars: 120_000,
};

export const SMALL_SET_LABEL = "small change set";
const PER_FILE_MAX_FILES = 20;

export async function bundleFiles(
  files: readonly FileDiff[],
  policy: BundlePolicy = defaultBundlePolicy,
  grouper?: FileGrouper,
): Promise<BundleResult> {
  if (files.length === 0) return { bundles: [], strategy: "per_file", warnings: [] };
  if (files.length === 1) return { bundles: perFile(files), strategy: "single", warnings: [] };

  if (files.length < policy.groupingMinFiles) {
    const bundles = enforceLimits([{ label: SMALL_SET_LABEL, files: [...files] }], policy);
    return { bundles, strategy: "small_set", warnings: [] };
  }

  if (!grouper) return withoutGrouping(files, policy, []);

  let raw: unknown;
  try {
    raw = await grouper.group(buildGroupingPrompt(files, policy.maxFilesPerBundle));
  } catch (error) {
    return fallback(files, policy, `grouping failed: ${errorMessage(error)}`);
  }
  const parsed = groupingResponseSchema.safeParse(raw);
  if (!parsed.success) return fallback(files, policy, "grouping returned an invalid response");

  const warnings: string[] = [];
  const bundles = fromGroups(files, parsed.data, warnings);
  return { bundles: enforceLimits(bundles, policy), strategy: "grouped", warnings };
}

function fromGroups(
  files: readonly FileDiff[],
  groups: { label: string; files: number[] }[],
  warnings: string[],
): Bundle[] {
  const assigned = new Set<number>();
  const bundles: Bundle[] = [];
  for (const group of groups) {
    const members = group.files.filter((i) => i >= 0 && i < files.length && !assigned.has(i));
    for (const i of members) assigned.add(i);
    if (members.length === 0) continue;
    bundles.push({
      label: group.label.trim() || (files[members[0] as number] as FileDiff).newPath,
      files: members.map((i) => files[i] as FileDiff),
    });
  }

  const missing = files.filter((_, i) => !assigned.has(i));
  if (missing.length > 0) {
    warnings.push(`grouping left ${missing.length} file(s) ungrouped; reviewing them individually`);
    bundles.push(...perFile(missing));
  }
  return bundles;
}

function enforceLimits(bundles: Bundle[], policy: BundlePolicy): Bundle[] {
  return bundles.flatMap((bundle) => {
    const chunks: Bundle[] = [];
    for (let i = 0; i < bundle.files.length; i += policy.maxFilesPerBundle) {
      chunks.push({
        label: bundle.label,
        files: bundle.files.slice(i, i + policy.maxFilesPerBundle),
      });
    }
    return chunks.flatMap((chunk) =>
      chunk.files.length > 1 && size(chunk) > policy.maxBundleChars
        ? perFile(chunk.files)
        : [chunk],
    );
  });
}

function fallback(files: readonly FileDiff[], policy: BundlePolicy, warning: string): BundleResult {
  return withoutGrouping(files, policy, [warning]);
}

function withoutGrouping(
  files: readonly FileDiff[],
  policy: BundlePolicy,
  reasons: string[],
): BundleResult {
  if (files.length <= (policy.perFileMaxFiles ?? PER_FILE_MAX_FILES)) {
    return {
      bundles: perFile(files),
      strategy: "per_file",
      warnings: reasons.map((r) => `${r}; reviewing per file`),
    };
  }
  return {
    bundles: byDirectory(files, policy),
    strategy: "per_directory",
    warnings: reasons.map((r) => `${r}; grouping by directory`),
  };
}

function byDirectory(files: readonly FileDiff[], policy: BundlePolicy): Bundle[] {
  const groups = new Map<string, FileDiff[]>();
  for (const file of files) {
    const slash = file.newPath.lastIndexOf("/");
    const dir = slash < 0 ? "." : file.newPath.slice(0, slash);
    groups.set(dir, [...(groups.get(dir) ?? []), file]);
  }
  return enforceLimits(
    [...groups].map(([dir, members]) => ({ label: dir === "." ? "(root)" : dir, files: members })),
    policy,
  );
}

function perFile(files: readonly FileDiff[]): Bundle[] {
  return files.map((f) => ({ label: f.newPath, files: [f] }));
}

function size(bundle: Bundle): number {
  return bundle.files.reduce((sum, f) => sum + f.patch.length, 0);
}
