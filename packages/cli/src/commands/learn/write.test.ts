import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LearningDraft } from "@open-cr-agent/core/internal";
import { afterEach, describe, expect, it } from "vitest";
import { parseLearning } from "../review/learnings.js";
import { learningFile, writeLearning } from "./write.js";

const draft: LearningDraft = {
  source: { kind: "fix-commit", ref: "a1b2c3d4e5f6" },
  title: "Release pooled connections: on every exit path",
  body: "Every `acquire()` needs a `release()` in a `finally`.",
  paths: ["src/db/**", "app/\\[lang\\]/**"],
  symbols: ["acquire"],
  keywords: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocra-learn-"));
  dirs.push(dir);
  return dir;
}

describe("learningFile", () => {
  it("writes the contract's format, which reads back as the same learning", () => {
    const parsed = parseLearning(learningFile(draft, "2026-11-21"));
    expect(parsed).toEqual({
      frontmatter: {
        title: draft.title,
        paths: draft.paths,
        symbols: ["acquire"],
        keywords: [],
        critical: false,
        source: draft.source,
        created: "2026-11-21",
      },
      body: draft.body,
    });
  });

  it("refuses a draft the contract would not read", () => {
    expect(() => learningFile({ ...draft, paths: [] }, "2026-11-21")).toThrow("invalid");
  });
});

describe("writeLearning", () => {
  it("names the file after the title and numbers a name already taken", async () => {
    const dir = root();
    const text = learningFile(draft, "2026-11-21");
    const first = await writeLearning(dir, text, draft.title);
    const second = await writeLearning(dir, text, draft.title);
    expect(first).toBe(".ocra/learnings/release-pooled-connections-on-every-exit-path.md");
    expect(second).toBe(".ocra/learnings/release-pooled-connections-on-every-exit-path-2.md");
    expect(readFileSync(join(dir, first), "utf8")).toBe(text);
  });

  it("refuses to write through a planted link", async () => {
    const dir = root();
    const elsewhere = root();
    mkdirSync(join(dir, ".ocra"));
    symlinkSync(elsewhere, join(dir, ".ocra", "learnings"));
    await expect(writeLearning(dir, "x", "Title")).rejects.toThrow("symbolic link");
  });
});
