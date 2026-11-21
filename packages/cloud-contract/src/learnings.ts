import { z } from "zod";

// A learning is one Markdown file with YAML frontmatter (ADR-0037). The
// contract stays Zod-only, so it splits the file and the caller parses the
// YAML before validating it here.

/** Where the learnings of a repository live, relative to its root. */
export const LEARNINGS_DIR = ".ocra/learnings";
/** Learning files read per repository; the rest are left out with a warning. */
export const MAX_LEARNINGS = 500;
/** Bytes of one learning file, frontmatter included. */
export const MAX_LEARNING_BYTES = 16_384;
/** Characters of one learning's body. */
export const MAX_LEARNING_BODY = 4_000;

/** A learning's id is its file name without `.md`. */
export const LEARNING_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

export const LEARNING_SOURCES = [
  "fix-commit",
  "review-feedback",
  "document",
  "remember",
  "incident",
  "manual",
] as const;
export type LearningSourceKind = (typeof LEARNING_SOURCES)[number];

const term = z.string().trim().min(1).max(100);

/** The frontmatter of a learning file, after its YAML is parsed. */
export const learningFrontmatterSchema = z.object({
  title: z.string().trim().min(1).max(200),
  paths: z.array(z.string().trim().min(1).max(200)).min(1).max(20),
  symbols: z.array(term).max(20).default([]),
  keywords: z.array(term).max(20).default([]),
  critical: z.boolean().default(false),
  source: z
    .object({
      kind: z.enum(LEARNING_SOURCES),
      ref: z.string().trim().min(1).max(200).optional(),
    })
    .optional(),
  created: z.iso.date(),
});
export type LearningFrontmatter = z.output<typeof learningFrontmatterSchema>;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/**
 * The frontmatter text and the body of a learning file, or undefined when
 * the file does not open with a `---` block.
 */
export function splitLearning(text: string): { frontmatter: string; body: string } | undefined {
  const match = FRONTMATTER.exec(text.replace(/^﻿/, ""));
  if (!match) return undefined;
  return { frontmatter: match[1] ?? "", body: (match[2] ?? "").trim() };
}

/** The id of the learning at a path under LEARNINGS_DIR, or undefined if it names none. */
export function learningIdOf(path: string): string | undefined {
  const prefix = `${LEARNINGS_DIR}/`;
  if (!path.startsWith(prefix) || !path.endsWith(".md")) return undefined;
  const id = path.slice(prefix.length, -".md".length);
  return LEARNING_ID.test(id) ? id : undefined;
}
