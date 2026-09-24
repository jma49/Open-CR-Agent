import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATASET_URL, loadDataset, parseRecords, toInstances } from "./dataset.js";
import { selectInstances } from "./select.js";

function record(overrides: Record<string, unknown> = {}) {
  return {
    project_main_language: "Go",
    pr_url: "https://github.com/acme/api/pull/7",
    pr_source_commit: "a".repeat(40),
    pr_target_commit: "b".repeat(40),
    pr_change_line_count: 120,
    pr_category: "Bug Fix",
    is_ai_comment: false,
    note: "nil map write",
    path: "server/handler.go",
    side: "right",
    source_model: "",
    from_line: 10,
    to_line: 12,
    category: "Code Defect",
    context: "File Level",
    label: 1,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("toInstances", () => {
  it("groups comments per PR and keeps only correct ones as references", () => {
    const [instance, ...rest] = toInstances(
      parseRecords([
        record(),
        record({ note: "wrong claim", label: 0 }),
        record({ note: "second issue", from_line: null, to_line: null }),
      ]),
    );
    expect(rest).toEqual([]);
    expect(instance).toMatchObject({
      id: "acme__api@bbbbbbb",
      repo: "acme/api",
      language: "Go",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      changeLines: 120,
    });
    expect(instance?.references.map((r) => [r.note, r.fromLine])).toEqual([
      ["nil map write", 10],
      ["second issue", null],
    ]);
  });
});

describe("loadDataset", () => {
  it("downloads once and then reads the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-dataset-"));
    dirs.push(dir);
    const cache = join(dir, "nested", "dataset.json");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([record()])));
    expect(await loadDataset(cache, fetchImpl as unknown as typeof fetch)).toHaveLength(1);
    expect(await loadDataset(cache, fetchImpl as unknown as typeof fetch)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(DATASET_URL);
    expect(JSON.parse(readFileSync(cache, "utf8"))).toHaveLength(1);
  });

  it("rejects malformed records", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocra-dataset-"));
    dirs.push(dir);
    const fetchImpl = async () => new Response(JSON.stringify([record({ side: "middle" })]));
    await expect(
      loadDataset(join(dir, "d.json"), fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow();
  });
});

describe("selectInstances", () => {
  const instances = toInstances(
    parseRecords(
      Array.from({ length: 10 }, (_, i) =>
        record({
          pr_url: `https://github.com/acme/repo${i}/pull/${i}`,
          project_main_language: i % 2 ? "Go" : "Python",
          pr_change_line_count: i * 100,
          label: i === 9 ? 0 : 1,
        }),
      ),
    ),
  );

  it("is deterministic for a seed and differs across seeds", () => {
    const a = selectInstances(instances, { seed: 7, limit: 4 }).map((i) => i.id);
    expect(selectInstances(instances, { seed: 7, limit: 4 }).map((i) => i.id)).toEqual(a);
    expect(selectInstances(instances, { seed: 8, limit: 4 }).map((i) => i.id)).not.toEqual(a);
  });

  it("filters by language, size, ids, and skips PRs without references", () => {
    const go = selectInstances(instances, { seed: 1, languages: ["go"], maxChangeLines: 500 });
    expect(go.every((i) => i.language === "Go" && i.changeLines <= 500)).toBe(true);
    expect(go).toHaveLength(3);
    expect(selectInstances(instances, { seed: 1 }).some((i) => i.repo === "acme/repo9")).toBe(
      false,
    );
    expect(selectInstances(instances, { seed: 1, ids: ["acme__repo3@bbbbbbb"] })).toHaveLength(1);
  });
});
