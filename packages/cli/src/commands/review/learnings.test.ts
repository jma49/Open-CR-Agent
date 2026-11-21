import { describe, expect, it } from "vitest";
import { loadLearnings, parseLearning } from "./learnings.js";
import type { TrustedTree } from "./target.js";

const valid = `---
title: Release pooled connections
paths: ["src/db/**"]
symbols: [acquire]
keywords: [connection pool]
critical: true
source: { kind: fix-commit, ref: abc1234 }
created: 2026-11-21
---

Every \`acquire()\` needs a \`release()\` on each exit path.
`;

function tree(files: Record<string, string>): TrustedTree {
  return {
    readFile: async (path) => files[path],
    listFiles: async (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
  };
}

async function load(files: Record<string, string>) {
  const warnings: string[] = [];
  const learnings = await loadLearnings(tree(files), (w) => warnings.push(w));
  return { learnings, warnings };
}

describe("loadLearnings", () => {
  it("reads each learning file of .ocra/learnings, its name as the id", async () => {
    const { learnings, warnings } = await load({ ".ocra/learnings/release-pooled.md": valid });
    expect(warnings).toEqual([]);
    expect(learnings).toEqual([
      {
        id: "release-pooled",
        title: "Release pooled connections",
        body: "Every `acquire()` needs a `release()` on each exit path.",
        paths: ["src/db/**"],
        symbols: ["acquire"],
        keywords: ["connection pool"],
        critical: true,
        source: { kind: "fix-commit", ref: "abc1234" },
      },
    ]);
  });

  it("skips a bad file with a warning and keeps the others", async () => {
    const { learnings, warnings } = await load({
      ".ocra/learnings/good.md": valid,
      ".ocra/learnings/no-paths.md": "---\ntitle: x\ncreated: 2026-11-21\n---\nBody",
      ".ocra/learnings/Bad Name.md": valid,
    });
    expect(learnings.map((l) => l.id)).toEqual(["good"]);
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain(".ocra/learnings/no-paths.md is skipped");
    expect(warnings.join("\n")).toContain(".ocra/learnings/Bad Name.md is skipped");
  });

  it("ignores files that are not Markdown", async () => {
    const { learnings, warnings } = await load({ ".ocra/learnings/README.txt": "notes" });
    expect(learnings).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("reads nothing when the trusted revision has no learnings", async () => {
    expect(await load({})).toEqual({ learnings: [], warnings: [] });
  });
});

describe("parseLearning", () => {
  it.each([
    ["no frontmatter", "Just text", "does not open with a --- frontmatter block"],
    ["an empty body", "---\ntitle: x\n---\n", "its body is empty"],
    ["broken YAML", "---\ntitle: [x\n---\nBody", "not valid YAML"],
    ["a duplicate key", "---\ntitle: a\ntitle: b\n---\nBody", "not valid YAML"],
    ["an alias", "---\na: &x [1]\nb: *x\n---\nBody", "not valid YAML"],
    ["a file past the size limit", `---\ntitle: x\n---\n${"x".repeat(20_000)}`, "larger than"],
    ["a body past its limit", `${valid}${"x".repeat(5_000)}`, "body is longer than"],
    ["a missing date", valid.replace("created: 2026-11-21\n", ""), "frontmatter is invalid"],
  ])("refuses %s", (_, text, reason) => {
    expect(parseLearning(text)).toContain(reason);
  });

  it("reads an unquoted date as text, not a timestamp", () => {
    const parsed = parseLearning(valid);
    expect(typeof parsed === "string" ? parsed : parsed.frontmatter.created).toBe("2026-11-21");
  });
});
