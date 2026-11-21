import { describe, expect, it } from "vitest";
import { learningFrontmatterSchema, learningIdOf, splitLearning } from "./learnings.js";

describe("splitLearning", () => {
  it("separates the frontmatter from the trimmed body", () => {
    expect(splitLearning("---\ntitle: x\n---\n\nCheck the pool.\n")).toEqual({
      frontmatter: "title: x",
      body: "Check the pool.",
    });
  });

  it("reads CRLF files and a leading byte order mark", () => {
    expect(splitLearning("﻿---\r\ntitle: x\r\n---\r\nBody")).toEqual({
      frontmatter: "title: x",
      body: "Body",
    });
  });

  it("allows an empty body", () => {
    expect(splitLearning("---\ntitle: x\n---")).toEqual({ frontmatter: "title: x", body: "" });
  });

  it("refuses a file without a leading frontmatter block", () => {
    expect(splitLearning("title: x\n---\nBody")).toBeUndefined();
    expect(splitLearning("---\ntitle: x\nBody")).toBeUndefined();
  });

  it("ends the frontmatter at the first closing line", () => {
    expect(splitLearning("---\na: 1\n---\nBody\n---\nmore")?.body).toBe("Body\n---\nmore");
  });
});

describe("learningIdOf", () => {
  it("takes the file name of a Markdown file directly in the directory", () => {
    expect(learningIdOf(".ocra/learnings/pool-release.md")).toBe("pool-release");
  });

  it.each([
    ".ocra/learnings/Pool.md",
    ".ocra/learnings/a/b.md",
    ".ocra/learnings/x.txt",
    ".ocra/learnings/.md",
    ".ocra/learnings/-x.md",
    "docs/x.md",
  ])("names no learning for %s", (path) => {
    expect(learningIdOf(path)).toBeUndefined();
  });
});

describe("the learning frontmatter", () => {
  const minimal = {
    title: "Release pooled connections",
    paths: ["src/db/**"],
    created: "2026-11-21",
  };

  it("fills the optional lists and the critical flag", () => {
    expect(learningFrontmatterSchema.parse(minimal)).toEqual({
      ...minimal,
      symbols: [],
      keywords: [],
      critical: false,
    });
  });

  it("keeps a source and ignores fields it does not know", () => {
    const parsed = learningFrontmatterSchema.parse({
      ...minimal,
      source: { kind: "fix-commit", ref: "abc1234" },
      futureField: 1,
    });
    expect(parsed.source).toEqual({ kind: "fix-commit", ref: "abc1234" });
    expect(parsed).not.toHaveProperty("futureField");
  });

  it.each([
    ["no paths", { ...minimal, paths: [] }],
    ["an empty title", { ...minimal, title: " " }],
    ["a date that is not a calendar date", { ...minimal, created: "2026-13-01" }],
    ["an unknown source", { ...minimal, source: { kind: "rumour" } }],
    ["a string for paths", { ...minimal, paths: "src/**" }],
  ])("refuses %s", (_, value) => {
    expect(learningFrontmatterSchema.safeParse(value).success).toBe(false);
  });
});
