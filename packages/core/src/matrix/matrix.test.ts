import { describe, expect, it } from "vitest";
import { type Bundle, bundlePolicyFor } from "../bundle/bundle.js";
import type { FileDiff } from "../domain.js";
import type { ReviewerDefinition } from "../review/reviewer.js";
import { agentsMdReviewer } from "../review/reviewers/agents-md.js";
import { docsReviewer } from "../review/reviewers/docs.js";
import { performanceReviewer } from "../review/reviewers/performance.js";
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

describe("a reviewer whose bundles are packed", () => {
  const packed = reviewer("security", { span: "packed", ignore: ["**/*.md"] });
  const sized = (path: string, chars = 10) =>
    ({ newPath: path, oldPath: path, patch: "x".repeat(chars) }) as FileDiff;

  it("reviews whole bundles together, named after the first, sensitive ones apart", () => {
    const b = [
      bundle("ui", "src/ui.ts", "README.md"),
      bundle("auth", "src/auth/login.ts"),
      bundle("api", "src/api.ts"),
      bundle("session", "src/auth/session.ts"),
    ];
    const matrix = planMatrix(b, [correctness, packed], "full");
    expect(
      matrix.cells.map((c) => [c.taskId, c.bundle.label, c.bundle.files.map((f) => f.newPath)]),
    ).toEqual([
      ["correctness-2", "auth", ["src/auth/login.ts"]],
      ["correctness-4", "session", ["src/auth/session.ts"]],
      ["correctness-1", "ui", ["src/ui.ts", "README.md"]],
      ["security-2", "auth + session", ["src/auth/login.ts", "src/auth/session.ts"]],
      ["correctness-3", "api", ["src/api.ts"]],
      ["security-1", "ui + api", ["src/ui.ts", "src/api.ts"]],
    ]);
  });

  it("keeps a pack within the bundle limits and never splits a bundle", () => {
    const four = (n: number) => ({
      label: `b${n}`,
      files: [0, 1, 2, 3].map((f) => sized(`src/b${n}/f${f}.ts`)),
    });
    const byFiles = planMatrix([four(0), four(1), four(2)], [packed], "full").cells;
    expect(byFiles.map((c) => [c.taskId, c.bundle.label, c.bundle.files.length])).toEqual([
      ["security-1", "b0 + b1", 8],
      ["security-3", "b2", 4],
    ]);

    const large = ["a", "b", "c"].map((n) => ({ label: n, files: [sized(`src/${n}.ts`, 50_000)] }));
    expect(planMatrix(large, [packed], "full").cells.map((c) => c.bundle.label)).toEqual([
      "a + b",
      "c",
    ]);
    const small = { bundling: bundlePolicyFor(16_000) };
    expect(planMatrix(large, [packed], "full", {}, small).cells.map((c) => c.bundle.label)).toEqual(
      ["a", "b", "c"],
    );
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

describe("a reviewer's focus paths", () => {
  const focused = reviewer("focused", {
    minTier: "full",
    focus: { words: new Set(["cache"]), minTier: "lite" },
    ignore: ["**/*.test.ts"],
  });

  it("bring it down to their tier on a bundle with a file on one", () => {
    const b = [bundle("cache", "src/CacheStore.ts", "src/api.ts"), bundle("api", "src/api.ts")];
    const lite = planMatrix(b, [focused], "lite");
    expect(cells(lite)).toEqual([["focused-1", ["src/CacheStore.ts", "src/api.ts"]]]);
    expect(lite.skipped).toEqual([{ reviewer: "focused", bundle: "api", reason: "below_tier" }]);
    expect(planMatrix(b, [focused], "trivial").skipped).toHaveLength(2);
  });

  it("count a file's old path, but not a file the reviewer ignores", () => {
    const renamed: Bundle = {
      label: "moved",
      files: [{ newPath: "src/store.ts", oldPath: "src/cache.ts", patch: "" } as FileDiff],
    };
    expect(cells(planMatrix([renamed], [focused], "lite"))).toEqual([
      ["focused-1", ["src/store.ts"]],
    ]);
    expect(
      planMatrix([bundle("tests", "src/cache.test.ts", "src/api.ts")], [focused], "lite").skipped,
    ).toEqual([{ reviewer: "focused", bundle: "tests", reason: "below_tier" }]);
  });

  it("yield to a repository's own tier and to --all-tiers", () => {
    const b = [bundle("cache", "src/cache.ts")];
    expect(planMatrix(b, [focused], "lite", { focused: { minTier: "full" } }).cells).toEqual([]);
    expect(cells(planMatrix(b, [focused], "trivial", {}, { allTiers: true }))).toEqual([
      ["focused-1", ["src/cache.ts"]],
    ]);
  });
});

describe("the performance reviewer", () => {
  it("runs from the lite tier on hot paths, and otherwise only at the full tier", () => {
    const hot = [bundle("cluster", "server/cluster/ClusterChangedEvent.java")];
    expect(cells(planMatrix(hot, [performanceReviewer], "lite"))).toEqual([
      ["performance-1", ["server/cluster/ClusterChangedEvent.java"]],
    ]);
    expect(
      planMatrix([bundle("entry", "src/index.ts")], [performanceReviewer], "lite").skipped,
    ).toEqual([{ reviewer: "performance", bundle: "entry", reason: "below_tier" }]);
  });

  it("runs only at the full tier, and a repository can bring it back lower", () => {
    const b = [bundle("api", "src/api.ts")];
    expect(planMatrix(b, [performanceReviewer], "lite").skipped).toEqual([
      { reviewer: "performance", bundle: "api", reason: "below_tier" },
    ]);
    expect(cells(planMatrix(b, [performanceReviewer], "full"))).toEqual([
      ["performance-1", ["src/api.ts"]],
    ]);
    expect(
      cells(planMatrix(b, [performanceReviewer], "lite", { performance: { minTier: "lite" } })),
    ).toEqual([["performance-1", ["src/api.ts"]]]);
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
