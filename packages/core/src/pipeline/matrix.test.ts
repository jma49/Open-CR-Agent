import { describe, expect, it } from "vitest";
import type { Bundle } from "../bundle/bundle.js";
import type { FileDiff } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { planMatrix } from "./matrix.js";

function bundle(label: string, ...paths: string[]): Bundle {
  return { label, files: paths.map((p) => ({ newPath: p, oldPath: p }) as FileDiff) };
}

function reviewer(id: string, scope?: ReviewerDefinition["scope"]): ReviewerDefinition {
  const definition: ReviewerDefinition = {
    id,
    category: id,
    modelTier: "standard",
    systemPrompt: "",
  };
  if (scope) definition.scope = scope;
  return definition;
}

const bundles = [bundle("api", "src/api.ts", "docs/api.md"), bundle("docs", "README.md")];
const correctness = reviewer("correctness");
const security = reviewer("security", { minTier: "lite", ignore: ["**/*.md"] });

function cells(matrix: ReturnType<typeof planMatrix>) {
  return matrix.cells.map((c) => [c.taskId, c.bundle.files.map((f) => f.newPath)]);
}

describe("planMatrix", () => {
  it("runs every reviewer on every bundle when scopes allow it", () => {
    const matrix = planMatrix(bundles, [correctness], "trivial");
    expect(cells(matrix)).toEqual([
      ["correctness-1", ["src/api.ts", "docs/api.md"]],
      ["correctness-2", ["README.md"]],
    ]);
    expect(matrix.skipped).toEqual([]);
  });

  it("skips reviewers below their tier and narrows bundles to the files they review", () => {
    expect(planMatrix(bundles, [correctness, security], "trivial").skipped).toEqual([
      { reviewer: "security", bundle: "api", reason: "below_tier" },
      { reviewer: "security", bundle: "docs", reason: "below_tier" },
    ]);

    const matrix = planMatrix(bundles, [correctness, security], "full");
    expect(cells(matrix)).toEqual([
      ["correctness-1", ["src/api.ts", "docs/api.md"]],
      ["security-1", ["src/api.ts"]],
      ["correctness-2", ["README.md"]],
    ]);
    expect(matrix.skipped).toEqual([
      { reviewer: "security", bundle: "docs", reason: "no_matching_files" },
    ]);
  });

  it("applies configuration overrides before the reviewer's own scope", () => {
    const matrix = planMatrix(bundles, [correctness, security], "lite", {
      correctness: { enabled: false },
      security: { minTier: "full" },
    });
    expect(matrix.cells).toEqual([]);
    expect(matrix.skipped.map((s) => s.reason)).toEqual([
      "disabled",
      "below_tier",
      "disabled",
      "below_tier",
    ]);
  });
});
