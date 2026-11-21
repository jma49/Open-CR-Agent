import { describe, expect, it } from "vitest";
import { MAX_LEARNING_CHARS, parseLearning } from "./learning.js";

const PATH = ".ocra/learnings/close-pool.md";

function file(frontmatter: string, body = "Close the pool on every exit path.") {
  return `---\n${frontmatter}\n---\n${body}\n`;
}

describe("parseLearning", () => {
  it("reads the frontmatter and body, with the file name as id", () => {
    const parsed = parseLearning(
      PATH,
      file(
        [
          "title: Close the pool on every exit path",
          "paths: [packages/runtime-*/src/**]",
          "symbols: [withPool]",
          "keywords: [connection leak]",
          "source: { kind: fix-commit, commit: 1a2b3c4d, pr: 412 }",
          "created: 2026-11-21",
        ].join("\n"),
      ),
    );
    expect(parsed).toEqual({
      learning: {
        id: "close-pool",
        title: "Close the pool on every exit path",
        paths: ["packages/runtime-*/src/**"],
        symbols: ["withPool"],
        keywords: ["connection leak"],
        critical: false,
        source: { kind: "fix-commit", commit: "1a2b3c4d", pr: 412 },
        created: "2026-11-21",
        body: "Close the pool on every exit path.",
      },
    });
  });

  it("accepts CRLF line endings and a byte order mark", () => {
    const parsed = parseLearning(PATH, `﻿---\r\ntitle: T\r\n---\r\nBody\r\n`);
    expect(parsed).toMatchObject({ learning: { title: "T", body: "Body" } });
  });

  it.each([
    ["no frontmatter", "Just text", "no YAML frontmatter"],
    ["an unclosed frontmatter", "---\ntitle: T\nBody", "no YAML frontmatter"],
    ["invalid YAML", file("title: [unclosed"), "invalid YAML"],
    ["a misspelt key", file("title: T\npath: [src/**]"), "path"],
    ["a missing title", file("paths: [src/**]"), "title"],
    ["an empty body", file("title: T", "  "), "the body is empty"],
    ["a critical learning without paths", file("title: T\ncritical: true"), "must list its paths"],
    ["an unknown source kind", file("title: T\nsource: { kind: chat }"), "kind"],
    [
      "a non-http source url",
      file("title: T\nsource: { kind: manual, url: 'file:///etc' }"),
      "url",
    ],
  ])("warns about %s instead of failing", (_, text, warning) => {
    const parsed = parseLearning(PATH, text);
    expect(parsed).toEqual({ warning: expect.stringContaining(warning) });
    expect((parsed as { warning: string }).warning.startsWith(PATH)).toBe(true);
  });

  it("refuses YAML aliases, which can expand without bound", () => {
    const parsed = parseLearning(PATH, file("title: &t T\nkeywords: [*t]"));
    expect(parsed).toEqual({ warning: expect.stringContaining("invalid YAML") });
  });

  it("refuses an oversized file before parsing it", () => {
    const parsed = parseLearning(PATH, file("title: T", "x".repeat(MAX_LEARNING_CHARS)));
    expect(parsed).toEqual({ warning: expect.stringContaining("longer than") });
  });

  it.each([
    ".ocra/learnings/a/b.md",
    ".ocra/learnings/.hidden.md",
    ".ocra/learnings/x.txt",
    ".ocra/rules.json",
  ])("refuses %s as a learning file", (path) => {
    expect(parseLearning(path, file("title: T"))).toEqual({
      warning: expect.stringContaining("not a .ocra/learnings/*.md file"),
    });
  });
});
