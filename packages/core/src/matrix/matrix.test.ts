import { describe, expect, it } from "vitest";
import type { Bundle } from "../bundle/bundle.js";
import type { FileDiff } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { agentsMdReviewer } from "../review/reviewers/agents-md.js";
import { docsReviewer } from "../review/reviewers/docs.js";
import { planMatrix, planTasks } from "./matrix.js";

function bundle(label: string, ...paths: string[]): Bundle {
  return { label, files: paths.map((p) => ({ newPath: p, oldPath: p, patch: "" }) as FileDiff) };
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

  it("runs every reviewer at every tier when asked, still respecting ignores and switches", () => {
    const matrix = planMatrix(
      bundles,
      [correctness, security],
      "trivial",
      { correctness: { enabled: false } },
      { allTiers: true },
    );
    expect(cells(matrix)).toEqual([["security-1", ["src/api.ts"]]]);
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

describe("a reviewer that spans the change", () => {
  const docs = reviewer("docs", { span: "change", ignore: ["**/*.test.ts"] });

  it("gets the change in one task, after the per-bundle tasks, sensitive files first", () => {
    const b = [
      bundle("ui", "src/ui.ts", "src/ui.test.ts"),
      bundle("auth", "src/auth/login.ts"),
      bundle("tests", "src/api.test.ts"),
    ];
    const matrix = planMatrix(b, [docs, correctness], "full");
    expect(cells(matrix)).toEqual([
      ["correctness-2", ["src/auth/login.ts"]],
      ["correctness-1", ["src/ui.ts", "src/ui.test.ts"]],
      ["correctness-3", ["src/api.test.ts"]],
      ["docs-1", ["src/auth/login.ts", "src/ui.ts"]],
    ]);
    expect(matrix.cells.at(-1)?.bundle.label).toBe("whole change");
    expect(matrix.skipped).toEqual([
      { reviewer: "docs", bundle: "tests", reason: "no_matching_files" },
    ]);
  });

  it("keeps the label of the only bundle it reviews", () => {
    const matrix = planMatrix([bundle("cli", "src/args.ts", "README.md")], [docs], "full");
    expect(matrix.cells.map((c) => [c.taskId, c.bundle.label])).toEqual([["docs-1", "cli"]]);
  });

  it("splits a change too large for one task by files and by diff size", () => {
    const sized = (path: string, chars: number) =>
      ({ newPath: path, oldPath: path, patch: "x".repeat(chars) }) as FileDiff;
    const small = Array.from({ length: 45 }, (_, i) => ({
      label: `b${i}`,
      files: [sized(`src/f${i}.ts`, 10)],
    }));
    const byFiles = planMatrix(small, [docs], "full").cells;
    expect(byFiles.map((c) => [c.taskId, c.bundle.label, c.bundle.files.length])).toEqual([
      ["docs-1", "whole change (1 of 3)", 20],
      ["docs-2", "whole change (2 of 3)", 20],
      ["docs-3", "whole change (3 of 3)", 5],
    ]);

    const large = ["a", "b", "c"].map((n) => ({ label: n, files: [sized(`src/${n}.ts`, 70_000)] }));
    expect(planMatrix(large, [docs], "full").cells.map((c) => c.bundle.files.length)).toEqual([
      1, 1, 1,
    ]);
  });
});

describe("planTasks", () => {
  const many = Array.from({ length: 4 }, (_, i) => bundle(`b${i}`, `src/f${i}.ts`));
  const performance = reviewer("performance");

  it("keeps every file's first reviewer and drops second samples first past the limit", () => {
    const ultra = planTasks(
      many,
      [correctness, performance],
      "full",
      {},
      {
        ultra: true,
        maxTasks: 6,
      },
    );
    expect(ultra.cells.map((c) => c.taskId)).toEqual([
      "correctness-1",
      "performance-1",
      "correctness-2",
      "performance-2",
      "correctness-3",
      "correctness-4",
    ]);
    expect(ultra.skipped.filter((s) => s.reason === "task_limit")).toHaveLength(10);

    const plain = planTasks(many, [correctness, performance], "full", {}, { maxTasks: 5 });
    expect(plain.cells.map((c) => c.taskId).sort()).toEqual(
      ["correctness-1", "correctness-2", "correctness-3", "correctness-4", "performance-1"].sort(),
    );
  });

  it("runs bundles on sensitive paths first and keeps their tasks past the limit", () => {
    const mixed = [
      bundle("ui", "src/ui/button.ts"),
      bundle("auth", "src/auth/session.ts"),
      bundle("ci", ".github/workflows/release.yml"),
      bundle("api", "src/api.ts"),
    ];
    const planned = planTasks(mixed, [correctness, performance], "full");
    expect(planned.cells.map((c) => c.taskId)).toEqual([
      "correctness-2",
      "performance-2",
      "correctness-3",
      "performance-3",
      "correctness-1",
      "performance-1",
      "correctness-4",
      "performance-4",
    ]);

    const limited = planTasks(mixed, [correctness, performance], "full", {}, { maxTasks: 5 });
    expect(limited.cells.map((c) => c.taskId)).toEqual([
      "correctness-2",
      "performance-2",
      "correctness-3",
      "correctness-1",
      "correctness-4",
    ]);
  });

  it("keeps plan order when no bundle is on a sensitive path", () => {
    expect(planTasks(many, [correctness], "full").cells.map((c) => c.taskId)).toEqual([
      "correctness-1",
      "correctness-2",
      "correctness-3",
      "correctness-4",
    ]);
  });

  it("changes nothing under the limit", () => {
    expect(planTasks(many, [correctness], "full").cells).toHaveLength(4);
  });
});

describe("the docs reviewer", () => {
  it("starts at the lite tier and never reviews tests", () => {
    const b = [bundle("cli", "src/args.ts", "README.md", "src/args.test.ts")];
    expect(planMatrix(b, [docsReviewer], "trivial").skipped).toEqual([
      { reviewer: "docs", bundle: "cli", reason: "below_tier" },
    ]);
    expect(cells(planMatrix(b, [docsReviewer], "lite"))).toEqual([
      ["docs-1", ["src/args.ts", "README.md"]],
    ]);
    expect(docsReviewer.modelTier).toBe("light");
  });
});

describe("the agents-md reviewer", () => {
  it("runs only when the repository has guidelines, from the lite tier", () => {
    const b = [bundle("build", "package.json", "src/cli.ts")];
    expect(planMatrix(b, [agentsMdReviewer], "lite").skipped).toEqual([
      { reviewer: "agents-md", bundle: "build", reason: "no_guidelines" },
    ]);
    expect(cells(planMatrix(b, [agentsMdReviewer], "lite", {}, { hasGuidelines: true }))).toEqual([
      ["agents-md-1", ["package.json", "src/cli.ts"]],
    ]);
    expect(
      planMatrix(b, [agentsMdReviewer], "trivial", {}, { hasGuidelines: true }).skipped,
    ).toEqual([{ reviewer: "agents-md", bundle: "build", reason: "below_tier" }]);
  });
});
