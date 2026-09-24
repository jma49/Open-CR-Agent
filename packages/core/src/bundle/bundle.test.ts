import { describe, expect, it, vi } from "vitest";
import type { FileDiff } from "../domain.js";
import { type BundlePolicy, bundleFiles, defaultBundlePolicy, SMALL_SET_LABEL } from "./bundle.js";
import type { FileGrouper } from "./grouping.js";

function file(path: string, patchChars = 10): FileDiff {
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: 1,
    deletions: 0,
    hunks: [],
    patch: "x".repeat(patchChars),
  };
}

const files = (n: number, chars = 10) =>
  Array.from({ length: n }, (_, i) => file(`f${i}.ts`, chars));
const paths = (bundles: { files: FileDiff[] }[]) =>
  bundles.map((b) => b.files.map((f) => f.newPath));
const grouper = (response: unknown): FileGrouper => ({ group: vi.fn(async () => response) });
const policy = (overrides: Partial<BundlePolicy>) => ({ ...defaultBundlePolicy, ...overrides });

describe("bundleFiles", () => {
  it("returns nothing for no files and one bundle for one file", async () => {
    expect((await bundleFiles([])).bundles).toEqual([]);
    const single = await bundleFiles(files(1));
    expect(single).toMatchObject({ strategy: "single", bundles: [{ label: "f0.ts" }] });
  });

  it("bundles small change sets together without calling the grouper", async () => {
    const g = grouper([]);
    const result = await bundleFiles(files(3), defaultBundlePolicy, g);
    expect(result.strategy).toBe("small_set");
    expect(result.bundles).toHaveLength(1);
    expect(result.bundles[0]?.label).toBe(SMALL_SET_LABEL);
    expect(g.group).not.toHaveBeenCalled();
  });

  it("splits a small set that exceeds the size budget into single files", async () => {
    const result = await bundleFiles(files(3, 50), policy({ maxBundleChars: 100 }));
    expect(paths(result.bundles)).toEqual([["f0.ts"], ["f1.ts"], ["f2.ts"]]);
  });

  it("reviews per file when no grouper is available", async () => {
    const result = await bundleFiles(files(5));
    expect(result).toMatchObject({ strategy: "per_file", warnings: [] });
    expect(result.bundles).toHaveLength(5);
  });

  it("builds bundles from the grouper's index groups", async () => {
    const g = grouper([
      { label: "auth", files: [0, 2] },
      { label: "ui", files: [1, 3, 4] },
    ]);
    const result = await bundleFiles(files(5), defaultBundlePolicy, g);
    expect(result.strategy).toBe("grouped");
    expect(result.bundles.map((b) => b.label)).toEqual(["auth", "ui"]);
    expect(paths(result.bundles)).toEqual([
      ["f0.ts", "f2.ts"],
      ["f1.ts", "f3.ts", "f4.ts"],
    ]);
  });

  it("sends indices, not diffs, to the grouper", async () => {
    const g = grouper([{ label: "all", files: [0, 1, 2, 3] }]);
    await bundleFiles(files(4), defaultBundlePolicy, g);
    const prompt = vi.mocked(g.group).mock.calls[0]?.[0];
    expect(prompt?.user.split("\n")[0]).toBe("[0] modified f0.ts (+1 -0)");
    expect(prompt?.system).toContain("At most 10 files per group.");
  });

  it("repairs duplicates, out-of-range indices, empty groups and missing files", async () => {
    const g = grouper([
      { label: "a", files: [0, 1, 99, -1] },
      { label: "b", files: [1] },
      { label: " ", files: [2] },
    ]);
    const result = await bundleFiles(files(4), defaultBundlePolicy, g);
    expect(paths(result.bundles)).toEqual([["f0.ts", "f1.ts"], ["f2.ts"], ["f3.ts"]]);
    expect(result.bundles[1]?.label).toBe("f2.ts");
    expect(result.warnings).toEqual([
      "grouping left 1 file(s) ungrouped; reviewing them individually",
    ]);
  });

  it("splits groups over the file limit and over the size budget", async () => {
    const g = grouper([{ label: "big", files: [0, 1, 2, 3, 4] }]);
    const byCount = await bundleFiles(files(5), policy({ maxFilesPerBundle: 2 }), g);
    expect(paths(byCount.bundles)).toEqual([["f0.ts", "f1.ts"], ["f2.ts", "f3.ts"], ["f4.ts"]]);

    const bySize = await bundleFiles(files(5, 50), policy({ maxBundleChars: 100 }), g);
    expect(bySize.bundles).toHaveLength(5);
  });

  it("falls back to per-file review on grouper errors or invalid output", async () => {
    const failing: FileGrouper = { group: async () => Promise.reject(new Error("timeout")) };
    expect(await bundleFiles(files(4), defaultBundlePolicy, failing)).toMatchObject({
      strategy: "per_file",
      warnings: ["grouping failed: timeout; reviewing per file"],
    });
    const invalid = await bundleFiles(files(4), defaultBundlePolicy, grouper({ groups: "nope" }));
    expect(invalid).toMatchObject({
      strategy: "per_file",
      warnings: ["grouping returned an invalid response; reviewing per file"],
    });
  });
});
