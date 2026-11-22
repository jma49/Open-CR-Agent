import type { FileDiff } from "../domain.js";
import type { Learning } from "../knowledge/learning.js";
import type { MemoryEntry } from "../memory/memory.js";
import type { AnalyzerResult } from "../sarif/evidence.js";
import type { LinkedTask } from "../task/linked-task.js";
import type { ReviewPromptInput } from "./prompt.js";
import { correctnessReviewer } from "./reviewers/correctness.js";

// Review prompt inputs with every context source, either small or as large
// as the stages before the prompt let each one grow (ADR-0057).
export type ContextSize = "small" | "largest";

const text = (chars: number, word = "context") =>
  `${word} `.repeat(Math.ceil(chars / (word.length + 1))).slice(0, chars);

function diff(n: number): FileDiff {
  const path = `src/module-${String(n).padStart(4, "0")}/component/file.ts`;
  return {
    oldPath: path,
    newPath: path,
    kind: "modified",
    isBinary: false,
    additions: 1,
    deletions: 1,
    hunks: [
      {
        header: "@@ -1 +1 @@",
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: [
          { kind: "delete", content: "const b = 2;", oldLine: 1 },
          { kind: "add", content: "const b = 3;", newLine: 1 },
        ],
      },
    ],
    patch: "@@ -1 +1 @@\n-const b = 2;\n+const b = 3;",
  };
}

function task(n: number, size: ContextSize): LinkedTask {
  const big = size === "largest";
  return {
    tracker: "github",
    key: `#${n}`,
    title: text(big ? 1_000 : 40, "title"),
    labels: Array.from({ length: big ? 10 : 1 }, (_, i) => `label-${i}`),
    body: text(big ? 50_000 : 400, "task"),
    parent: { key: "#1", title: text(big ? 1_000 : 40, "epic"), body: text(big ? 50_000 : 200) },
    subtasks: Array.from({ length: big ? 10 : 1 }, (_, i) => ({
      key: `#${100 + i}`,
      title: text(big ? 1_000 : 40, "sub"),
    })),
  };
}

function learning(n: number, bodyChars: number, titleChars: number): Learning {
  return {
    id: `learning-${n}`,
    title: text(titleChars, "rule"),
    body: text(bodyChars, "lesson"),
    paths: ["src/**"],
    symbols: [],
    keywords: [],
    critical: false,
  };
}

function accepted(n: number, size: ContextSize): MemoryEntry {
  const big = size === "largest";
  return {
    fingerprint: n.toString(16).padStart(16, "0"),
    file: "src/module-0000/component/file.ts",
    title: text(big ? 2_000 : 60, "accepted"),
    reason: text(big ? 2_000 : 60, "because"),
  };
}

function analyzer(n: number): AnalyzerResult {
  return {
    tool: { name: "Semgrep OSS", slug: "semgrep-oss" },
    file: "src/module-0000/component/file.ts",
    lines: { start: n + 1, end: n + 1 },
    severity: "warning",
    ruleId: `rule-${n}`,
    message: text(300, "message"),
    security: false,
    onChange: true,
  };
}

export function contextInput(size: ContextSize): ReviewPromptInput {
  const big = size === "largest";
  const changed = Array.from({ length: big ? 3_000 : 3 }, (_, i) => diff(i));
  return {
    reviewer: correctnessReviewer,
    changeRequest: {
      id: "1",
      title: text(big ? 5_000 : 40, "title"),
      description: text(big ? 100_000 : 500, "description"),
      baseSha: "base",
      headSha: "head",
    },
    changedFiles: changed,
    bundle: changed.slice(0, 1),
    rules: "### Rules\n- rule",
    repoRules: `### Repository rules\n${text(big ? 100_000 : 300, "rule")}`,
    guidelines: text(big ? 100_000 : 500, "guideline"),
    // Linked tasks arrive bound to their number (boundLinkedTasks), learnings
    // to their count and characters (selectLearnings), project docs to their
    // count (sectionsFor), analyzer results to theirs (analyzerEvidence) and
    // callers to theirs (findCallers).
    linkedTasks: Array.from({ length: big ? 3 : 1 }, (_, i) => task(i + 2, size)),
    accepted: Array.from({ length: big ? 1_000 : 2 }, (_, i) => accepted(i, size)),
    learnings: Array.from({ length: big ? 5 : 1 }, (_, i) =>
      learning(i, big ? 1_600 : 200, big ? 1_000 : 40),
    ),
    moreLearnings: Array.from({ length: big ? 200 : 0 }, (_, i) => learning(100 + i, 200, 1_000)),
    projectDocs: {
      given: Array.from({ length: big ? 3 : 1 }, (_, i) => ({
        path: "docs/design.md",
        heading: `Section ${i}`,
        text: text(big ? 50_000 : 400, "design"),
        order: i,
      })),
      more: Array.from({ length: big ? 10 : 0 }, (_, i) => ({
        path: "docs/design.md",
        heading: `More ${i}`,
        text: "",
        order: 10 + i,
      })),
    },
    callers: Array.from({ length: big ? 8 : 1 }, (_, i) => ({
      symbol: `symbol${i}`,
      uses: Array.from({ length: big ? 10 : 1 }, (_, j) => ({
        path: `src/caller-${j}.ts`,
        line: j + 1,
        text: text(big ? 1_000 : 40, "call"),
        within: `caller${j}`,
      })),
    })),
    analyzerResults: Array.from({ length: big ? 20 : 1 }, (_, i) => analyzer(i)),
  };
}
